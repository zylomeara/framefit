import { describe, expect, it } from 'vitest';
import { getCommentsUseCase } from '../../src/application/get-comments.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { FilterCriteria, RawComment } from '../../src/domain/types.js';

const silent = createLogger({ level: 'silent' });

const nodeComment: RawComment = {
  id: 'root-1',
  message: 'Synthetic thread',
  user: { id: 'author-1', handle: 'writer', img_url: '' },
  created_at: '2026-01-01T00:00:00Z',
  client_meta: { node_id: 'node-1', node_offset: { x: 0, y: 0 } },
};

class CosmeticAnchorFailureApi {
  async getComments(): Promise<RawComment[]> { return [nodeComment]; }
  async getNodesRaw(): Promise<never> { throw new FigmaApiError('too_large', 400, 'metadata failed'); }
  async getFileStructure(): Promise<never> { throw new FigmaApiError('too_large', 400, 'whole file must not be fetched'); }
}

class CountingApi {
  calls: string[][] = [];
  constructor(private readonly comments: RawComment[]) {}
  async getComments(): Promise<RawComment[]> { return this.comments; }
  async getNodesRaw(_file: string, ids: string[]): Promise<any> {
    this.calls.push(ids);
    return { nodes: Object.fromEntries(ids.map((id) => [id, { document: { id, name: `label-${id}`, type: 'RECTANGLE' } }])) };
  }
  async getFileStructure(): Promise<never> { throw new Error('whole-file metadata must not be fetched'); }
}

function useCaseInput(
  criteria: FilterCriteria = { include_resolved: true, include_descendants: false },
  limit = 10,
) {
  return { file: 'SYNTHETIC', criteria, as_markdown: false, node_depth: 0, limit, offset: 0 };
}

describe('comments anchor bounds', () => {
  it('keeps a page when optional node-name enrichment fails', async () => {
    const out = await getCommentsUseCase(
      new CosmeticAnchorFailureApi() as unknown as FigmaApi,
      silent,
      {
        file: 'SYNTHETIC',
        criteria: { include_resolved: true, include_descendants: false },
        as_markdown: false,
        node_depth: 0,
        limit: 10,
        offset: 0,
      },
    );

    expect(out.page.map((thread) => thread.id)).toEqual(['root-1']);
    expect(out.total_matching).toBe(1);
    expect(out.coverage.filter.complete).toBe(true);
    expect(out.coverage.enrichment).toMatchObject({
      complete: false,
      unresolved_node_ids: ['node-1'],
      error: { kind: 'too_large', status: 400 },
    });
  });

  it('returns an exact empty node filter without metadata', async () => {
    const canvasComment: RawComment = {
      ...nodeComment,
      id: 'canvas-root',
      client_meta: { x: 0, y: 0 },
    };
    const api = new CountingApi([canvasComment]);
    const out = await getCommentsUseCase(
      api as unknown as FigmaApi,
      silent,
      useCaseInput({ include_resolved: true, include_descendants: false, node_id: 'missing-node' }),
    );

    expect(out.page).toEqual([]);
    expect(api.calls).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: true, candidate_threads: 0, count_semantics: 'exact' });
  });

  it('enriches only the requested page selection', async () => {
    const api = new CountingApi([
      nodeComment,
      { ...nodeComment, id: 'root-2', client_meta: { node_id: 'node-2', node_offset: { x: 0, y: 0 } } },
    ]);
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, useCaseInput(undefined, 1));

    expect(out.page.map((thread) => thread.id)).toEqual(['root-1']);
    expect(api.calls).toEqual([['node-1']]);
  });
});
