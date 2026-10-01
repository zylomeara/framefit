import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveAnchors } from '../../src/application/resolve-anchors.js';
import type { RawFileResponse, RawSceneNode } from '../../src/domain/figma-raw.js';
import type { Thread } from '../../src/domain/types.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { FigmaApiError } from '../../src/ports/errors.js';

const node = (id: string, type: string, children: RawSceneNode[] = []): RawSceneNode => ({ id, name: id, type, children });
const projection = (children: RawSceneNode[]): RawFileResponse => ({
  name: 'Sample', lastModified: '2025-01-15T00:00:00Z', version: 'v1',
  document: node('document', 'DOCUMENT', children),
});
const thread = (id: string): Thread => ({
  id, kind: 'single', resolved: false,
  anchor: { kind: 'node', node_id: id, node_name: '', page_name: '', offset: { x: 0, y: 0 } },
  root: { id, author: { id: 'reader', handle: 'Reader' }, created_at: '2025-01-15T00:00:00Z', message: 'Spacing', mentions: [], reactions_count: 0 },
  replies: [],
});
const opts = { node_id: 'scope', include_descendants: true, node_depth: 0 };
const scoped = (id: string) => projection([node('scope', 'CANVAS', [node(id, 'RECTANGLE')])]);
const ambiguous = () => projection([
  node('page-a', 'CANVAS', [node('scope', 'FRAME', [node('target', 'RECTANGLE')])]),
  node('page-b', 'CANVAS', [node('wrapper', 'FRAME', [node('nested', 'FRAME', [node('scope', 'FRAME')])])]),
]);

afterEach(() => vi.useRealTimers());

describe('scope proof boundaries', () => {
  it('does not classify a target when metadata ingestion reaches its deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const target = node('target', 'RECTANGLE');
    let reads = 0;
    Object.defineProperty(target, 'id', { get() { if (++reads === 2) vi.setSystemTime(10); return 'target'; } });
    const api = { getDocumentByIdsRaw: async () => projection([node('scope', 'CANVAS', [target])]) } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('target')], { ...opts, deadlineAt: 10 });
    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'deadline' });
  });

  it.each([{ label: 'null', invalid: null }, { label: 'missing', invalid: undefined }, { label: 'array', invalid: [] }])('retains proven matches when a projection child is malformed: $label', async ({ invalid }) => {
    const children = [node('known', 'RECTANGLE'), invalid] as RawSceneNode[];
    const api = {
      getDocumentByIdsRaw: async () => projection([node('scope', 'CANVAS', children)]),
      getNodesRaw: async () => ({ version: 'v1', nodes: {} }),
    } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('known'), thread('missing')], opts);
    expect(out.threads.map((t) => t.id)).toEqual(['known']);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'unknown_scope' });
  });

  it('does not accept an ancestor identity occurring at distinct scope paths', async () => {
    const api = { getDocumentByIdsRaw: async () => ambiguous() } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('target')], opts);
    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'unknown_scope' });
  });

  it('keeps earlier independent proofs when a later projection has ambiguous scope paths', async () => {
    const api = { getDocumentByIdsRaw: async (_file: string, ids: string[]) => {
      if (ids.length > 1) throw new FigmaApiError('too_large', 0, 'large');
      return ids[0] === 'known' ? scoped('known') : ambiguous();
    } } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('known'), thread('target')], opts);
    expect(out.threads.map((t) => t.id)).toEqual(['known']);
    expect(out.threads[0].anchor).toMatchObject({ page_name: 'scope' });
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'unknown_scope' });
  });

  it('restores prior scope metadata after discarding an ambiguous projection', async () => {
    const api = { getDocumentByIdsRaw: async (_file: string, ids: string[]) => {
      if (ids.length > 1) throw new FigmaApiError('too_large', 0, 'large');
      return ids[0] === 'known' ? scoped('known') : ambiguous();
    } } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('scope'), thread('known'), thread('target')], { ...opts, node_type: 'CANVAS' });
    expect(out.threads.map((t) => t.id)).toEqual(['scope']);
    expect(out.threads[0].anchor).toMatchObject({ node_name: 'scope', page_name: 'scope' });
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1 });
  });

  it.each(['rate_limited', 'deadline'] as const)('preserves a terminal %s stop over a deferred size error', async (terminal) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let presenceCalls = 0;
    const api = {
      getDocumentByIdsRaw: async (_file: string, ids: string[], depth: number) => {
        if (ids.length > 1 || (ids[0] === 'missing' && depth === 3)) throw new FigmaApiError('too_large', 0, 'large');
        if (ids[0] === 'missing') return projection([node('scope', 'CANVAS')]);
        if (terminal === 'rate_limited') throw new FigmaApiError('rate_limited', 429, 'wait', 7);
        return scoped('known');
      },
      getNodesRaw: async () => { presenceCalls++; vi.setSystemTime(10); return { version: 'v1', nodes: { missing: null } }; },
    } as unknown as FigmaApi;
    const out = await resolveAnchors(api, 'sample', [thread('missing'), thread('known')], { ...opts, deadlineAt: 10 });
    expect(out.coverage.filter.complete).toBe(false);
    if (terminal === 'rate_limited') {
      expect(presenceCalls).toBe(0);
      expect(out.coverage.filter.error).toEqual({ kind: 'rate_limited', status: 429, retry_after_sec: 7 });
    } else {
      expect(presenceCalls).toBe(1);
      expect(out.threads.map((t) => t.id)).toEqual(['known']);
      expect(out.coverage.filter.stop_reason).toBe('deadline');
      expect(out.coverage.filter.error).toBeUndefined();
    }
  });
});
