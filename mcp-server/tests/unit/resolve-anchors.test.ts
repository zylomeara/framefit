import { describe, expect, it } from 'vitest';
import { resolveAnchors } from '../../src/application/resolve-anchors.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { CommentInThread, Thread } from '../../src/domain/types.js';
import type { RawSceneNode } from '../../src/domain/figma-raw.js';

function comment(): CommentInThread {
  return { id: 'comment', author: { id: 'author', handle: 'writer' }, created_at: '2026-01-01T00:00:00Z', message: 'synthetic', mentions: [], reactions_count: 0 };
}
function nodeThread(id: string, nodeId: string): Thread {
  return { id, kind: 'single', resolved: false, anchor: { kind: 'node', node_id: nodeId, node_name: '', page_name: '', offset: { x: 0, y: 0 } }, root: comment(), replies: [] };
}
function raw(id: string, type: string, children?: RawSceneNode[]): RawSceneNode {
  return { id, name: `name-${id}`, type, ...(children === undefined ? {} : { children }) };
}

class NodeApi {
  calls: string[][] = [];
  constructor(
    private readonly nodes: Record<string, RawSceneNode>,
    private readonly failure?: Error,
  ) {}
  async getNodesRaw(_fileKey: string, ids: string[]): Promise<{ nodes: Record<string, { document: RawSceneNode } | null> }> {
    this.calls.push(ids);
    if (this.failure) throw this.failure;
    return { nodes: Object.fromEntries(ids.map((id) => [id, this.nodes[id] ? { document: this.nodes[id] } : null])) };
  }
  async getFileStructure(): Promise<never> { throw new Error('whole-file metadata must not be fetched'); }
}

const noFilter = { include_descendants: false, node_depth: 0 };

describe('resolveAnchors', () => {
  it('resolves hidden nested descendants through depth-one batches', async () => {
    const target = raw('target', 'RECTANGLE');
    target.visible = false;
    const nested = raw('nested', 'FRAME', [target]);
    const page = raw('page', 'CANVAS', [nested]);
    const api = new NodeApi({ page, nested, target });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads.map((thread) => thread.id)).toEqual(['thread']);
    expect(out.threads[0].anchor).toMatchObject({ node_name: 'name-target', page_name: 'name-page' });
    expect(out.coverage.filter).toMatchObject({ complete: true, count_semantics: 'exact' });
    expect(out.coverage.enrichment.complete).toBe(true);
    expect(api.calls).toEqual([['page'], ['nested']]);
  });

  it('reports an unknown branch rather than claiming a negative descendant match', async () => {
    const mystery = raw('mystery', 'UNFAMILIAR');
    const api = new NodeApi({ page: raw('page', 'FRAME', [mystery]), mystery });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'unseen')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound', stop_reason: 'unknown_scope' });
  });

  it('proves a negative descendant match only after an exhausted subtree', async () => {
    const api = new NodeApi({ page: raw('page', 'FRAME', []) });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0, count_semantics: 'exact' });
  });

  it('treats a missing scope root as unresolved', async () => {
    const api = new NodeApi({});
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], {
      node_id: 'missing-root', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'scope_root_missing' });
  });

  it('stops a scope walk once every candidate anchor is found', async () => {
    const first = raw('first', 'RECTANGLE');
    const second = raw('second', 'ELLIPSE');
    const api = new NodeApi({ page: raw('page', 'CANVAS', [first, second]), first, second });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('one', 'first'), nodeThread('two', 'second')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads.map((thread) => thread.id)).toEqual(['one', 'two']);
    expect(api.calls).toEqual([['page']]);
  });

  it('marks a descendant beyond the index cap as unresolved', async () => {
    const children = Array.from({ length: 10_001 }, (_, index) => raw(`child-${index}`, 'RECTANGLE'));
    let lateFieldReads = 0;
    Object.defineProperties(children.at(-1)!, {
      name: { get: () => { lateFieldReads++; return 'late'; } },
      type: { get: () => { lateFieldReads++; return 'RECTANGLE'; } },
    });
    const api = new NodeApi({ page: raw('page', 'CANVAS', children) });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'child-10000')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({
      complete: false,
      unresolved_threads: 1,
      count_semantics: 'lower_bound',
      stop_reason: 'node_visit_cap',
    });
    expect(lateFieldReads).toBe(0);
    expect(api.calls).toEqual([['page']]);
  });

  it('keeps indexed positive descendants when the child list reaches the cap', async () => {
    const children = Array.from({ length: 10_001 }, (_, index) => raw(`child-${index}`, 'RECTANGLE'));
    const api = new NodeApi({ page: raw('page', 'CANVAS', children) });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'child-0')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads.map((thread) => thread.id)).toEqual(['thread']);
    expect(out.coverage.filter).toMatchObject({ complete: true, count_semantics: 'exact' });
    expect(out.coverage.enrichment).toMatchObject({ complete: true, stop_reason: 'node_visit_cap' });
    expect(api.calls).toEqual([['page']]);
  });

  it('batches direct type checks by at most fifty anchors', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `anchor-${index}`);
    const api = new NodeApi(Object.fromEntries(ids.map((id) => [id, raw(id, 'RECTANGLE')])));
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', ids.map((id) => nodeThread(id, id)), {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(out.threads).toHaveLength(51);
    expect(api.calls).toHaveLength(2);
    expect(api.calls.every((batch) => batch.length <= 50)).toBe(true);
  });

  it('stops metadata work at an expired deadline', async () => {
    const api = new NodeApi({});
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      node_id: 'page', include_descendants: true, node_depth: 0, deadlineAt: Date.now() - 1,
    });

    expect(api.calls).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, stop_reason: 'deadline', count_semantics: 'lower_bound' });
  });

  it('stops after the first Figma metadata error and preserves its diagnosis', async () => {
    const api = new NodeApi({}, new FigmaApiError('rate_limited', 429, 'later', 7));
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('one', 'one'), nodeThread('two', 'two')], {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(api.calls).toHaveLength(1);
    expect(out.coverage.filter).toMatchObject({ complete: false, error: { kind: 'rate_limited', status: 429, retry_after_sec: 7 } });
  });

  it('bounds type reads at sixteen metadata calls', async () => {
    const ids = Array.from({ length: 801 }, (_, index) => `bounded-${index}`);
    const api = new NodeApi(Object.fromEntries(ids.map((id) => [id, raw(id, 'RECTANGLE')])));
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', ids.map((id) => nodeThread(id, id)), {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(api.calls).toHaveLength(16);
    expect(out.coverage.filter).toMatchObject({ complete: false, count_semantics: 'lower_bound', stop_reason: 'metadata_call_cap' });
    expect(out.threads).toHaveLength(800);
  });

  it('propagates programming errors from metadata reads', async () => {
    const api = new NodeApi({}, new Error('programming fault'));
    await expect(resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      ...noFilter, node_type: 'RECTANGLE',
    })).rejects.toThrow('programming fault');
  });
});
