import { describe, expect, it } from 'vitest';
import { resolveAnchors } from '../../src/application/resolve-anchors.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { CommentInThread, Thread } from '../../src/domain/types.js';
import type { RawFileResponse, RawSceneNode } from '../../src/domain/figma-raw.js';

function comment(): CommentInThread {
  return { id: 'comment', author: { id: 'author', handle: 'writer' }, created_at: '2026-01-01T00:00:00Z', message: 'synthetic', mentions: [], reactions_count: 0 };
}
function nodeThread(id: string, nodeId: string): Thread {
  return { id, kind: 'single', resolved: false, anchor: { kind: 'node', node_id: nodeId, node_name: '', page_name: '', offset: { x: 0, y: 0 } }, root: comment(), replies: [] };
}
function raw(id: string, type: string, children?: RawSceneNode[]): RawSceneNode {
  return { id, name: `name-${id}`, type, ...(children === undefined ? {} : { children }) };
}
function document(...pages: RawSceneNode[]): RawSceneNode {
  return raw('document', 'DOCUMENT', pages);
}

class NodeApi {
  nodeCalls: { ids: string[]; depth: number; version?: string }[] = [];
  fileCalls: { ids: string[]; depth: number; version?: string }[] = [];

  constructor(
    private readonly nodes: Record<string, RawSceneNode>,
    private readonly options: {
      projection?: RawSceneNode;
      omittedKeys?: Set<string>;
      nodeFailure?: Error;
      fileFailure?: Error;
    } = {},
  ) {}

  async getDocumentByIdsRaw(_fileKey: string, ids: string[], depth: number, version?: string): Promise<RawFileResponse> {
    this.fileCalls.push({ ids: [...ids], depth, ...(version === undefined ? {} : { version }) });
    if (this.options.fileFailure) throw this.options.fileFailure;
    return {
      name: 'Synthetic file',
      lastModified: '2026-01-01T00:00:00Z',
      version: 'version-one',
      document: this.options.projection ?? document(),
    };
  }

  async getNodesRaw(_fileKey: string, ids: string[], depth = 4, version?: string): Promise<{ version?: string; nodes: Record<string, { document: RawSceneNode } | null> }> {
    this.nodeCalls.push({ ids: [...ids], depth, ...(version === undefined ? {} : { version }) });
    if (this.options.nodeFailure) throw this.options.nodeFailure;
    const entries = ids.flatMap((id) => this.options.omittedKeys?.has(id)
      ? []
      : [[id, this.nodes[id] ? { document: this.nodes[id] } : null] as const]);
    return { ...(version === undefined ? {} : { version: 'version-one' }), nodes: Object.fromEntries(entries) };
  }
}

const noFilter = { include_descendants: false, node_depth: 0 };

describe('resolveAnchors', () => {
  it('uses a canvas name as its page name for exact and type metadata reads', async () => {
    const page = raw('page', 'CANVAS');

    for (const opts of [
      { node_id: 'page', include_descendants: false, node_depth: 0 },
      { ...noFilter, node_type: 'CANVAS' },
    ]) {
      const api = new NodeApi({ page });
      const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'page')], opts);

      expect(out.threads[0].anchor).toMatchObject({ node_name: 'name-page', page_name: 'name-page' });
      expect(out.coverage.enrichment).toMatchObject({ complete: true, resolved_page_names: 1 });
    }
  });

  it('resolves a hidden nested descendant from a candidate-only document projection', async () => {
    const target = raw('target', 'RECTANGLE');
    target.visible = false;
    const nested = raw('nested', 'FRAME', [target]);
    const page = raw('page', 'CANVAS', [nested]);
    const api = new NodeApi({}, { projection: document(page) });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads.map((thread) => thread.id)).toEqual(['thread']);
    expect(out.threads[0].anchor).toMatchObject({ node_name: 'name-target', page_name: 'name-page' });
    expect(out.coverage.filter).toMatchObject({ complete: true, count_semantics: 'exact' });
    expect(out.coverage.enrichment.complete).toBe(true);
    expect(api.fileCalls).toEqual([{ ids: ['target'], depth: 3 }]);
    expect(api.nodeCalls).toEqual([]);
  });

  it('reports an omitted candidate as unknown when the pinned node response lacks its key', async () => {
    const page = raw('page', 'CANVAS');
    const api = new NodeApi({ page }, { projection: document(), omittedKeys: new Set(['unseen']) });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'unseen')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound' });
    expect(api.nodeCalls).toEqual([{ ids: ['unseen', 'page'], depth: 1, version: 'version-one' }]);
  });

  it('proves a negative descendant match from an own null at the pinned version', async () => {
    const page = raw('page', 'CANVAS');
    const api = new NodeApi({ page }, { projection: document() });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0, count_semantics: 'exact' });
    expect(api.nodeCalls).toEqual([{ ids: ['outside', 'page'], depth: 1, version: 'version-one' }]);
  });

  it('treats an absent scope root as unresolved', async () => {
    const outside = raw('outside', 'RECTANGLE');
    const api = new NodeApi({}, { projection: document(raw('page', 'CANVAS', [outside])) });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], {
      node_id: 'missing-root', include_descendants: true, node_depth: 0,
    });

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'scope_root_missing' });
    expect(api.nodeCalls).toEqual([{ ids: ['missing-root'], depth: 1, version: 'version-one' }]);
  });

  it('projects all distinct candidate anchors in one bounded request', async () => {
    const first = raw('first', 'RECTANGLE');
    const second = raw('second', 'ELLIPSE');
    const page = raw('page', 'CANVAS', [first, second]);
    const api = new NodeApi({}, { projection: document(page) });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('one', 'first'), nodeThread('two', 'second')], {
      node_id: 'page', include_descendants: true, node_depth: 0,
    });

    expect(out.threads.map((thread) => thread.id)).toEqual(['one', 'two']);
    expect(api.fileCalls).toEqual([{ ids: ['first', 'second'], depth: 3 }]);
    expect(api.nodeCalls).toEqual([]);
  });

  it('batches direct type checks by at most fifty anchors', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `anchor-${index}`);
    const api = new NodeApi(Object.fromEntries(ids.map((id) => [id, raw(id, 'RECTANGLE')])));
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', ids.map((id) => nodeThread(id, id)), {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(out.threads).toHaveLength(51);
    expect(api.nodeCalls).toHaveLength(2);
    expect(api.nodeCalls.every((call) => call.ids.length <= 50)).toBe(true);
    expect(api.fileCalls).toEqual([]);
  });

  it('stops metadata work at an expired deadline', async () => {
    const api = new NodeApi({});
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      node_id: 'page', include_descendants: true, node_depth: 0, deadlineAt: Date.now() - 1,
    });

    expect(api.fileCalls).toEqual([]);
    expect(api.nodeCalls).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, stop_reason: 'deadline', count_semantics: 'lower_bound' });
  });

  it('stops after the first Figma metadata error and preserves its diagnosis', async () => {
    const api = new NodeApi({}, { nodeFailure: new FigmaApiError('rate_limited', 429, 'later', 7) });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('one', 'one'), nodeThread('two', 'two')], {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(api.nodeCalls).toHaveLength(1);
    expect(out.coverage.filter).toMatchObject({ complete: false, error: { kind: 'rate_limited', status: 429, retry_after_sec: 7 } });
  });

  it('bounds type reads at sixteen metadata calls', async () => {
    const ids = Array.from({ length: 801 }, (_, index) => `bounded-${index}`);
    const api = new NodeApi(Object.fromEntries(ids.map((id) => [id, raw(id, 'RECTANGLE')])));
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', ids.map((id) => nodeThread(id, id)), {
      ...noFilter, node_type: 'RECTANGLE',
    });

    expect(api.nodeCalls).toHaveLength(16);
    expect(out.coverage.filter).toMatchObject({ complete: false, count_semantics: 'lower_bound', stop_reason: 'metadata_call_cap' });
    expect(out.threads).toHaveLength(800);
  });

  it('propagates programming errors from metadata reads', async () => {
    const api = new NodeApi({}, { nodeFailure: new Error('programming fault') });
    await expect(resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], {
      ...noFilter, node_type: 'RECTANGLE',
    })).rejects.toThrow('programming fault');
  });
});
