import { describe, expect, it, vi } from 'vitest';
import { resolveAnchors } from '../../src/application/resolve-anchors.js';
import { getCommentsUseCase } from '../../src/application/get-comments.js';
import { findThreadsUseCase } from '../../src/application/find-threads.js';
import { summarizeCommentsUseCase } from '../../src/application/summarize-comments.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { CommentInThread, RawComment, Thread } from '../../src/domain/types.js';
import type { RawFileResponse, RawSceneNode } from '../../src/domain/figma-raw.js';

type FileCall = { ids: string[]; depth: number; version?: string };
type NodeCall = { ids: string[]; depth: number; version?: string };
type FileHook = (call: FileCall, fallback: () => RawFileResponse) => RawFileResponse;
type NodeHook = (call: NodeCall, fallback: () => NodesRaw) => NodesRaw;
type NodesRaw = { version?: string; nodes: Record<string, { document: RawSceneNode } | null> };

function scene(id: string, type: string, children?: RawSceneNode[]): RawSceneNode {
  return { id, name: `label-${id}`, type, ...(children === undefined ? {} : { children }) };
}

function document(...pages: RawSceneNode[]): RawSceneNode {
  return scene('document', 'DOCUMENT', pages);
}

function comment(id = 'comment'): CommentInThread {
  return {
    id,
    author: { id: 'author', handle: 'writer' },
    created_at: '2026-01-01T00:00:00Z',
    message: 'synthetic message',
    mentions: [],
    reactions_count: 0,
  };
}

function nodeThread(id: string, nodeId: string): Thread {
  return {
    id,
    kind: 'single',
    resolved: false,
    anchor: { kind: 'node', node_id: nodeId, node_name: '', page_name: '', offset: { x: 0, y: 0 } },
    root: comment(id),
    replies: [],
  };
}

function canvasThread(id: string): Thread {
  return {
    id,
    kind: 'single',
    resolved: false,
    anchor: { kind: 'canvas_point', x: 0, y: 0 },
    root: comment(id),
    replies: [],
  };
}

function allPaths(root: RawSceneNode, wanted: string): RawSceneNode[][] {
  const found: RawSceneNode[][] = [];
  const stack: { node: RawSceneNode; path: RawSceneNode[] }[] = [{ node: root, path: [] }];
  while (stack.length) {
    const { node, path } = stack.pop()!;
    const next = [...path, node];
    if (node.id === wanted) found.push(next);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index--) {
      stack.push({ node: node.children![index], path: next });
    }
  }
  return found;
}

function cloneRelative(node: RawSceneNode, depth: number): RawSceneNode {
  const copy = { ...node };
  if (depth <= 0 || !node.children) {
    delete copy.children;
  } else {
    copy.children = node.children.map((child) => cloneRelative(child, depth - 1));
  }
  return copy;
}

/** Test transport model: /files depth is measured from DOCUMENT; /nodes depth is relative to each id. */
function projectDocument(root: RawSceneNode, ids: string[], depth: number): RawSceneNode {
  const included = new Set<RawSceneNode>([root]);
  for (const id of ids) {
    for (const path of allPaths(root, id)) {
      for (let index = 0; index < path.length && index <= depth; index++) included.add(path[index]);
    }
  }
  const clone = (node: RawSceneNode): RawSceneNode => {
    const copy = { ...node };
    const children = node.children?.filter((child) => included.has(child)).map(clone);
    if (children?.length) copy.children = children;
    else delete copy.children;
    return copy;
  };
  return clone(root);
}

function oracleMembership(root: RawSceneNode, scopeId: string, targetId: string): boolean | undefined {
  if (targetId === scopeId) return true;
  const paths = allPaths(root, targetId);
  if (paths.length !== 1) return undefined;
  return paths[0].some((node) => node.id === scopeId);
}

class ProjectionApi {
  readonly fileCalls: FileCall[] = [];
  readonly nodeCalls: NodeCall[] = [];
  version = 'version-one';

  constructor(
    readonly root: RawSceneNode,
    private readonly fileHook?: FileHook,
    private readonly nodeHook?: NodeHook,
  ) {}

  async getDocumentByIdsRaw(
    _fileKey: string,
    ids: string[],
    depth: number,
    version?: string,
  ): Promise<RawFileResponse> {
    const call = { ids: [...ids], depth, ...(version === undefined ? {} : { version }) };
    this.fileCalls.push(call);
    const fallback = (): RawFileResponse => ({
      name: 'Synthetic file',
      lastModified: '2026-01-01T00:00:00Z',
      version: this.version,
      document: projectDocument(this.root, ids, depth),
    });
    return this.fileHook ? this.fileHook(call, fallback) : fallback();
  }

  async getNodesRaw(
    _fileKey: string,
    ids: string[],
    depth = 4,
    version?: string,
  ): Promise<NodesRaw> {
    const call = { ids: [...ids], depth, ...(version === undefined ? {} : { version }) };
    this.nodeCalls.push(call);
    const fallback = (): NodesRaw => ({
      version: this.version,
      nodes: Object.fromEntries(ids.map((id) => {
        const match = allPaths(this.root, id)[0]?.at(-1);
        return [id, match ? { document: cloneRelative(match, depth) } : null];
      })),
    });
    return this.nodeHook ? this.nodeHook(call, fallback) : fallback();
  }
}

class CommentsProjectionApi extends ProjectionApi {
  constructor(root: RawSceneNode, private readonly comments: RawComment[]) {
    super(root);
  }

  async getComments(): Promise<RawComment[]> {
    return this.comments;
  }
}

function rawComment(id: string, nodeId: string, message: string): RawComment {
  return {
    id,
    message,
    user: { id: 'author', handle: 'writer', img_url: '' },
    created_at: '2026-01-01T00:00:00Z',
    client_meta: { node_id: nodeId, node_offset: { x: 0, y: 0 } },
  };
}

const silent = createLogger({ level: 'silent' });

const scoped = (scopeId: string, extra: Partial<Parameters<typeof resolveAnchors>[3]> = {}) => ({
  node_id: scopeId,
  include_descendants: true,
  node_depth: 0,
  ...extra,
});

function resolvedIds(result: Awaited<ReturnType<typeof resolveAnchors>>): string[] {
  return result.threads.map((thread) => thread.id);
}

describe('candidate-only comment scope projection', () => {
  it('matches an independently enumerated synthetic tree, including hidden and outside anchors', async () => {
    const hidden = scene('hidden-target', 'RECTANGLE');
    hidden.visible = false;
    const root = document(
      scene('page-a', 'CANVAS', [
        scene('scope', 'FRAME', [scene('inside', 'TEXT'), scene('nested', 'FRAME', [hidden])]),
        scene('outside', 'ELLIPSE'),
      ]),
      scene('page-b', 'CANVAS', [scene('other-page', 'VECTOR')]),
    );
    const ids = ['inside', 'hidden-target', 'outside', 'other-page'];
    const expected = ids.filter((id) => oracleMembership(root, 'scope', id) === true);
    const api = new ProjectionApi(root);

    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      ids.map((id) => nodeThread(id, id)),
      scoped('scope'),
    );

    expect(resolvedIds(out)).toEqual(expected);
    expect(out.coverage.filter).toMatchObject({ complete: true, evaluated_threads: 4, unresolved_threads: 0, count_semantics: 'exact' });
    expect(out.threads.map((thread) => thread.anchor)).toEqual([
      expect.objectContaining({ node_name: 'label-inside', page_name: 'label-page-a' }),
      expect.objectContaining({ node_name: 'label-hidden-target', page_name: 'label-page-a' }),
    ]);
    expect(api.fileCalls[0]).toEqual({ ids, depth: 3 });
    expect(api.fileCalls.slice(1).every((call) => call.version === 'version-one')).toBe(true);
    expect(api.fileCalls.every((call) => !call.ids.includes('scope'))).toBe(true);
  });

  it('deepens only a still-existing omitted anchor and never repeats its presence check', async () => {
    const root = document(scene('page', 'CANVAS', [
      scene('scope', 'FRAME', [scene('level-a', 'FRAME', [scene('level-b', 'FRAME', [scene('deep', 'TEXT')])])]),
    ]));
    const api = new ProjectionApi(root);

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'deep')], scoped('scope'));

    expect(resolvedIds(out)).toEqual(['thread']);
    expect(api.fileCalls.map((call) => ({ ids: call.ids, depth: call.depth, version: call.version }))).toEqual([
      { ids: ['deep'], depth: 3, version: undefined },
      { ids: ['deep'], depth: 4, version: 'version-one' },
      { ids: ['deep'], depth: 5, version: 'version-one' },
    ]);
    expect(api.nodeCalls).toHaveLength(1);
    expect(api.nodeCalls[0]).toEqual({ ids: ['deep'], depth: 1, version: 'version-one' });
  });

  it('treats an own null omission as a proven nonmatch only after validating the scope', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [])]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'absent')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: true, evaluated_threads: 1, unresolved_threads: 0, count_semantics: 'exact' });
    expect(api.nodeCalls).toEqual([{ ids: ['absent', 'scope'], depth: 1, version: 'version-one' }]);
  });

  it('keeps an omitted id unresolved when the pinned node response omits its key', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [])]));
    const api = new ProjectionApi(root, undefined, (call, fallback) => {
      const response = fallback();
      if (call.ids.includes('unknown')) delete response.nodes.unknown;
      return response;
    });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'unknown')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, evaluated_threads: 0, unresolved_threads: 1, count_semantics: 'lower_bound' });
  });

  it('reports scope_root_missing when the scope is absent or cannot be verified', async () => {
    const root = document(scene('page', 'CANVAS', [scene('outside', 'RECTANGLE')]));
    const absent = new ProjectionApi(root);
    const absentOut = await resolveAnchors(absent as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], scoped('scope'));
    expect(absentOut.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'scope_root_missing' });

    const unverified = new ProjectionApi(root, undefined, (call, fallback) => {
      const response = fallback();
      if (call.ids.includes('scope')) delete response.nodes.scope;
      return response;
    });
    const unverifiedOut = await resolveAnchors(unverified as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'outside')], scoped('scope'));
    expect(unverifiedOut.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'scope_root_missing' });
  });

  it('uses explicit ancestry rather than canvas, dependency, name, or geometry similarities', async () => {
    const trueTarget = scene('inside', 'RECTANGLE');
    trueTarget.absoluteBoundingBox = { x: 10, y: 10, width: 20, height: 20 };
    const falseTarget = scene('outside', 'RECTANGLE');
    falseTarget.name = trueTarget.name;
    falseTarget.absoluteBoundingBox = { ...trueTarget.absoluteBoundingBox };
    const dependency = scene('dependency', 'FRAME', [scene('dependency-child', 'TEXT')]);
    const root = document(
      scene('page-a', 'CANVAS', [scene('scope', 'FRAME', [trueTarget]), falseTarget, dependency]),
      scene('page-b', 'CANVAS', [scene('other', 'FRAME')]),
    );
    const api = new ProjectionApi(root, (call, fallback) => {
      const response = fallback();
      response.document.children!.push(cloneRelative(root.children![1], 3));
      response.document.children![0].children!.push(cloneRelative(dependency, 3));
      return response;
    });

    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('inside-thread', 'inside'), nodeThread('outside-thread', 'outside')],
      scoped('scope'),
    );

    expect(resolvedIds(out)).toEqual(['inside-thread']);
    expect(out.coverage.filter.complete).toBe(true);
  });

  it('marks a target with contradictory repeated ancestry paths unresolved', async () => {
    const root = document(scene('page', 'CANVAS', [
      scene('scope', 'FRAME', [scene('repeated', 'TEXT')]),
      scene('other', 'FRAME', [scene('repeated', 'TEXT')]),
    ]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'repeated')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, evaluated_threads: 0, unresolved_threads: 1, count_semantics: 'lower_bound' });
  });

  it('rejects malformed initial roots and missing initial versions as unknown', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('target', 'TEXT')])]));
    for (const mutate of [
      (response: RawFileResponse) => { response.document.type = 'FRAME'; },
      (response: RawFileResponse) => { response.version = ''; },
    ]) {
      const api = new ProjectionApi(root, (_call, fallback) => {
        const response = fallback();
        mutate(response);
        return response;
      });
      const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));
      expect(out.threads).toEqual([]);
      expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound' });
      expect(api.nodeCalls).toEqual([]);
    }
  });

  it('pins every later read and rejects a mutated or absent response version', async () => {
    const root = document(scene('page', 'CANVAS', [
      scene('scope', 'FRAME', [scene('a', 'FRAME', [scene('b', 'FRAME', [scene('target', 'TEXT')])])]),
    ]));
    for (const returnedVersion of ['version-two', undefined]) {
      const api = new ProjectionApi(root, undefined, (call, fallback) => {
        const response = fallback();
        if (call.version) response.version = returnedVersion;
        return response;
      });
      const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));
      expect(out.threads).toEqual([]);
      expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound' });
      expect(api.nodeCalls[0].version).toBe('version-one');
      expect(api.fileCalls).toHaveLength(1);
    }
  });

  it('rejects a version mutation during pinned projection deepening', async () => {
    const root = document(scene('page', 'CANVAS', [
      scene('scope', 'FRAME', [scene('a', 'FRAME', [scene('b', 'FRAME', [scene('target', 'TEXT')])])]),
    ]));
    const api = new ProjectionApi(root, (call, fallback) => {
      const response = fallback();
      if (call.version) response.version = 'version-two';
      return response;
    });
    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound' });
    expect(api.fileCalls.map((call) => call.version)).toEqual([undefined, 'version-one']);
  });

  it('does not treat malformed or mismatched node entries as existence evidence', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME')]));
    for (const malformed of [
      {} as { document: RawSceneNode },
      { document: scene('different-id', 'TEXT') },
    ]) {
      const api = new ProjectionApi(root, undefined, (call, fallback) => {
        const response = fallback();
        if (call.ids.includes('unknown')) response.nodes.unknown = malformed;
        return response;
      });
      const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'unknown')], scoped('scope'));
      expect(out.threads).toEqual([]);
      expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, count_semantics: 'lower_bound' });
      expect(api.fileCalls).toHaveLength(1);
    }
  });

  it('treats malformed node response maps as unknown while retaining proven matches', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('inside', 'TEXT')])]));
    const malformedResponses: unknown[] = [
      null,
      1,
      [],
      {},
      { version: 'version-one' },
      { version: 'version-one', nodes: null },
      { version: 'version-one', nodes: [] },
      { version: 'version-one', nodes: 1 },
    ];

    for (const malformed of malformedResponses) {
      const api = new ProjectionApi(root, undefined, () => malformed as NodesRaw);
      const out = await resolveAnchors(
        api as unknown as FigmaApi,
        'synthetic',
        [nodeThread('inside-thread', 'inside'), nodeThread('unknown-thread', 'unknown')],
        scoped('scope'),
      );

      expect(resolvedIds(out)).toEqual(['inside-thread']);
      expect(out.coverage.filter).toMatchObject({
        complete: false,
        evaluated_threads: 1,
        unresolved_threads: 1,
        count_semantics: 'lower_bound',
        stop_reason: 'unknown_scope',
      });
    }
  });

  it('keeps the exact-self shortcut and performs a direct type read when it is the only node candidate', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME')]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('self', 'scope')],
      scoped('scope', { node_type: 'FRAME' }),
    );

    expect(resolvedIds(out)).toEqual(['self']);
    expect(api.fileCalls).toEqual([]);
    expect(api.nodeCalls).toEqual([{ ids: ['scope'], depth: 1 }]);
  });

  it('uses the projection version for mixed exact-self type reads', async () => {
    const root = document(scene('page', 'CANVAS', [
      scene('scope', 'FRAME'),
      scene('outside', 'RECTANGLE'),
    ]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('self', 'scope'), nodeThread('outside-thread', 'outside')],
      scoped('scope', { node_type: 'FRAME' }),
    );

    expect(resolvedIds(out)).toEqual(['self']);
    expect(api.fileCalls).toHaveLength(1);
    expect(api.nodeCalls).toEqual([{ ids: ['scope'], depth: 1, version: 'version-one' }]);
  });

  it('does no document or node metadata work for empty and non-node candidate sets', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME')]));
    const emptyApi = new ProjectionApi(root);
    const empty = await resolveAnchors(emptyApi as unknown as FigmaApi, 'synthetic', [], scoped('scope'));
    expect(empty.coverage.filter).toMatchObject({ complete: true, candidate_threads: 0, count_semantics: 'exact' });
    expect(emptyApi.fileCalls).toEqual([]);
    expect(emptyApi.nodeCalls).toEqual([]);

    const canvasApi = new ProjectionApi(root);
    const canvas = await resolveAnchors(canvasApi as unknown as FigmaApi, 'synthetic', [canvasThread('canvas')], scoped('scope'));
    expect(canvas.threads).toEqual([]);
    expect(canvas.coverage.filter).toMatchObject({ complete: true, evaluated_threads: 1, count_semantics: 'exact' });
    expect(canvasApi.fileCalls).toEqual([]);
    expect(canvasApi.nodeCalls).toEqual([]);
  });

  it('batches candidate projections at fifty and stops at sixteen metadata calls', async () => {
    const children = Array.from({ length: 801 }, (_, index) => scene(`target-${index}`, 'RECTANGLE'));
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', children)]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      children.map((node) => nodeThread(`thread-${node.id}`, node.id)),
      scoped('scope'),
    );

    expect(api.fileCalls).toHaveLength(16);
    expect(api.fileCalls.every((call) => call.ids.length <= 50)).toBe(true);
    expect(api.fileCalls[0].version).toBeUndefined();
    expect(api.fileCalls.slice(1).every((call) => call.version === 'version-one')).toBe(true);
    expect(out.threads).toHaveLength(800);
    expect(out.coverage.filter).toMatchObject({ complete: false, evaluated_threads: 800, unresolved_threads: 1, stop_reason: 'metadata_call_cap', count_semantics: 'lower_bound' });
  });

  it('counts unresolved threads rather than distinct repeated anchor ids', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME')]));
    const api = new ProjectionApi(root, undefined, (_call, fallback) => {
      const response = fallback();
      delete response.nodes.unknown;
      return response;
    });
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one', 'unknown'), nodeThread('two', 'unknown')],
      scoped('scope'),
    );

    expect(out.coverage.filter).toMatchObject({ candidate_threads: 2, evaluated_threads: 0, unresolved_threads: 2, count_semantics: 'lower_bound' });
  });

  it('retains and enriches proven positives when an unrelated candidate stays unresolved', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('inside', 'TEXT')])]));
    const api = new ProjectionApi(root, undefined, (call, fallback) => {
      const response = fallback();
      if (call.ids.includes('unknown')) delete response.nodes.unknown;
      return response;
    });
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('inside-thread', 'inside'), nodeThread('unknown-thread', 'unknown')],
      scoped('scope'),
    );

    expect(resolvedIds(out)).toEqual(['inside-thread']);
    expect(out.threads[0].anchor).toMatchObject({ node_name: 'label-inside', page_name: 'label-page' });
    expect(out.coverage.filter).toMatchObject({ complete: false, evaluated_threads: 1, unresolved_threads: 1, count_semantics: 'lower_bound' });
    expect(out.coverage.enrichment).toMatchObject({ complete: true, requested_nodes: 1 });
  });

  it('checks the deadline before the first projection call', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('target', 'TEXT')])]));
    const api = new ProjectionApi(root);
    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('thread', 'target')],
      scoped('scope', { deadlineAt: Date.now() - 1 }),
    );

    expect(api.fileCalls).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'deadline', count_semantics: 'lower_bound' });
  });

  it('stops projection ingestion at the deadline without reading later nodes', async () => {
    let currentTime = 0;
    let lateReads = 0;
    let expiredChildReads = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const early = scene('early', 'TEXT');
      const expirer = scene('expirer', 'FRAME');
      Object.defineProperties(expirer, {
        type: { get: () => { currentTime = 10; return 'FRAME'; } },
        children: { get: () => { expiredChildReads++; return [scene('unread-child', 'TEXT')]; } },
      });
      const late = scene('late', 'TEXT');
      Object.defineProperties(late, {
        id: { get: () => { lateReads++; return 'late'; } },
        name: { get: () => { lateReads++; return 'label-late'; } },
        type: { get: () => { lateReads++; return 'TEXT'; } },
      });
      const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [early, expirer, late])]));
      const api = new ProjectionApi(root, () => ({
        name: 'Synthetic file',
        lastModified: '2026-01-01T00:00:00Z',
        version: 'version-one',
        document: root,
      }));

      const out = await resolveAnchors(
        api as unknown as FigmaApi,
        'synthetic',
        [nodeThread('early-thread', 'early'), nodeThread('late-thread', 'late')],
        scoped('scope', { deadlineAt: 10 }),
      );

      expect(resolvedIds(out)).toEqual(['early-thread']);
      expect(out.coverage.filter).toMatchObject({ complete: false, evaluated_threads: 1, unresolved_threads: 1, stop_reason: 'deadline', count_semantics: 'lower_bound' });
      expect(lateReads).toBe(0);
      expect(expiredChildReads).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it('does not ingest a node response that arrives at the deadline', async () => {
    let currentTime = 0;
    let nodesReads = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const root = document(scene('page', 'CANVAS', [scene('target', 'TEXT')]));
      const api = new ProjectionApi(root, undefined, (_call, fallback) => {
        const response = fallback();
        const nodes = response.nodes;
        currentTime = 10;
        Object.defineProperty(response, 'nodes', { get: () => { nodesReads++; return nodes; } });
        return response;
      });

      const out = await resolveAnchors(
        api as unknown as FigmaApi,
        'synthetic',
        [nodeThread('thread', 'target')],
        { include_descendants: false, node_depth: 0, node_type: 'TEXT', deadlineAt: 10 },
      );

      expect(out.threads).toEqual([]);
      expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 1, stop_reason: 'deadline', count_semantics: 'lower_bound' });
      expect(nodesReads).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it('caps unrelated projection nodes before reading fields and retains an earlier proven positive', async () => {
    let lateReads = 0;
    const extras = Array.from({ length: 10_100 }, (_, index) => scene(`dependency-${index}`, 'RECTANGLE'));
    Object.defineProperties(extras.at(-1)!, {
      id: { get: () => { lateReads++; return 'late-id'; } },
      name: { get: () => { lateReads++; return 'late-name'; } },
      type: { get: () => { lateReads++; return 'RECTANGLE'; } },
    });
    const target = scene('target', 'TEXT');
    const oversized = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [target]), scene('dependencies', 'FRAME', extras)]));
    const api = new ProjectionApi(oversized, () => ({
      name: 'Synthetic file',
      lastModified: '2026-01-01T00:00:00Z',
      version: 'version-one',
      document: oversized,
    }));

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(resolvedIds(out)).toEqual(['thread']);
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0, count_semantics: 'exact' });
    expect(out.coverage.enrichment).toMatchObject({ complete: true, stop_reason: 'node_visit_cap' });
    expect(lateReads).toBe(0);
  });

  it('does not inspect a reached target subtree when its ancestor path already proves membership', async () => {
    let childReads = 0;
    const child = scene('unused-child', 'TEXT');
    Object.defineProperties(child, {
      id: { get: () => { childReads++; return 'unused-child'; } },
      name: { get: () => { childReads++; return 'unused-child'; } },
      type: { get: () => { childReads++; return 'TEXT'; } },
    });
    const target = scene('target', 'FRAME', [child]);
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [target])]));
    const api = new ProjectionApi(root, () => ({
      name: 'Synthetic file',
      lastModified: '2026-01-01T00:00:00Z',
      version: 'version-one',
      document: root,
    }));

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(resolvedIds(out)).toEqual(['thread']);
    expect(childReads).toBe(0);
  });

  it('splits only confirmed too-large batches and preserves error details for other failures', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('one', 'TEXT'), scene('two', 'TEXT')])]));
    const splitApi = new ProjectionApi(root, (call, fallback) => {
      if (call.ids.length > 1) throw new FigmaApiError('unknown_4xx', 400, 'rejected', undefined, 'Request too large');
      return fallback();
    });
    const split = await resolveAnchors(
      splitApi as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one-thread', 'one'), nodeThread('two-thread', 'two')],
      scoped('scope'),
    );
    expect(resolvedIds(split)).toEqual(['one-thread', 'two-thread']);
    expect(splitApi.fileCalls.map((call) => call.ids)).toEqual([['one', 'two'], ['one'], ['two']]);

    const error = new FigmaApiError('rate_limited', 429, 'later', 9);
    const failedApi = new ProjectionApi(root, () => { throw error; });
    const failed = await resolveAnchors(
      failedApi as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one-thread', 'one'), nodeThread('two-thread', 'two')],
      scoped('scope'),
    );
    expect(failedApi.fileCalls).toHaveLength(1);
    expect(failed.coverage.filter).toMatchObject({
      complete: false,
      unresolved_threads: 2,
      stop_reason: 'metadata_error',
      error: { kind: 'rate_limited', status: 429, retry_after_sec: 9 },
    });

    const rejectedApi = new ProjectionApi(root, () => {
      throw new FigmaApiError('unknown_4xx', 400, 'rejected', undefined, 'Invalid projection');
    });
    const rejected = await resolveAnchors(
      rejectedApi as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one-thread', 'one'), nodeThread('two-thread', 'two')],
      scoped('scope'),
    );
    expect(rejectedApi.fileCalls).toHaveLength(1);
    expect(rejected.coverage.filter).toMatchObject({
      complete: false,
      unresolved_threads: 2,
      stop_reason: 'metadata_error',
      error: { kind: 'unknown_4xx', status: 400 },
    });
  });

  it('bisects too-large node batches before deepening confirmed anchors', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [
      scene('branch-one', 'FRAME', [scene('one', 'TEXT')]),
      scene('branch-two', 'FRAME', [scene('two', 'TEXT')]),
    ])]));
    const api = new ProjectionApi(root, undefined, (call, fallback) => {
      if (call.ids.length > 1) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      return fallback();
    });

    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one-thread', 'one'), nodeThread('two-thread', 'two')],
      scoped('scope'),
    );

    expect(resolvedIds(out)).toEqual(['one-thread', 'two-thread']);
    expect(out.coverage.filter).toMatchObject({ complete: true, count_semantics: 'exact' });
    expect(api.nodeCalls.map((call) => call.ids)).toEqual([['one', 'two'], ['one'], ['two']]);
    expect(api.nodeCalls.every((call) => call.version === 'version-one')).toBe(true);
    expect(api.fileCalls.map((call) => ({ ids: call.ids, depth: call.depth }))).toEqual([
      { ids: ['one', 'two'], depth: 3 },
      { ids: ['one', 'two'], depth: 4 },
    ]);
  });

  it('retains a successful node half when the other half fails', async () => {
    const root = document(scene('page', 'CANVAS', [scene('one', 'RECTANGLE'), scene('two', 'RECTANGLE')]));
    const api = new ProjectionApi(root, undefined, (call, fallback) => {
      if (call.ids.length > 1) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      if (call.ids[0] === 'two') throw new FigmaApiError('rate_limited', 429, 'later', 6);
      return fallback();
    });

    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('one-thread', 'one'), nodeThread('two-thread', 'two')],
      { include_descendants: false, node_depth: 0, node_type: 'RECTANGLE' },
    );

    expect(resolvedIds(out)).toEqual(['one-thread']);
    expect(out.coverage.filter).toMatchObject({
      complete: false,
      evaluated_threads: 1,
      unresolved_threads: 1,
      count_semantics: 'lower_bound',
      stop_reason: 'metadata_error',
      error: { kind: 'rate_limited', status: 429, retry_after_sec: 6 },
    });
    expect(api.nodeCalls.map((call) => call.ids)).toEqual([['one', 'two'], ['one'], ['two']]);
  });

  it('keeps a valid half isolated from a mismatched pinned node response', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('inside', 'TEXT')])]));
    const api = new ProjectionApi(root, undefined, (call, fallback) => {
      if (call.ids.length > 1) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      const response = fallback();
      if (call.ids[0] === 'unknown') response.version = 'version-two';
      return response;
    });

    const out = await resolveAnchors(
      api as unknown as FigmaApi,
      'synthetic',
      [nodeThread('inside-thread', 'inside'), nodeThread('absent-thread', 'absent'), nodeThread('unknown-thread', 'unknown')],
      scoped('scope'),
    );

    expect(resolvedIds(out)).toEqual(['inside-thread']);
    expect(out.coverage.filter).toMatchObject({
      complete: false,
      evaluated_threads: 2,
      unresolved_threads: 1,
      count_semantics: 'lower_bound',
      stop_reason: 'unknown_scope',
    });
    expect(api.nodeCalls).toEqual([
      { ids: ['absent', 'unknown'], depth: 1, version: 'version-one' },
      { ids: ['absent'], depth: 1, version: 'version-one' },
      { ids: ['unknown'], depth: 1, version: 'version-one' },
    ]);
  });

  it('recovers a singleton projection from a too-large overshoot at a shallower depth without retrying the failed request', async () => {
    const root = document(scene('scope', 'CANVAS', [scene('target', 'TEXT')]));
    const api = new ProjectionApi(root, (call, fallback) => {
      if (call.ids.length === 1 && call.depth === 3) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      return fallback();
    });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(resolvedIds(out)).toEqual(['thread']);
    expect(api.fileCalls.map((call) => call.depth)).toEqual([3, 1, 2]);
    expect(new Set(api.fileCalls.map((call) => `${call.ids.join(',')}:${call.depth}:${call.version ?? ''}`)).size).toBe(api.fileCalls.length);
  });

  it('settles a singleton too-large omission from a pinned null presence check', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('target', 'TEXT')])]));
    const api = new ProjectionApi(root, (call, fallback) => {
      if (call.depth === 3) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      return fallback();
    }, (call, fallback) => {
      const response = fallback();
      if (call.ids.includes('target')) response.nodes.target = null;
      return response;
    });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({ complete: true, evaluated_threads: 1, unresolved_threads: 0, count_semantics: 'exact' });
    expect(api.fileCalls.map((call) => call.depth)).toEqual([3, 1, 2]);
    expect(api.nodeCalls).toEqual([{ ids: ['target'], depth: 1, version: 'version-one' }]);
  });

  it('keeps the singleton too-large diagnosis when presence remains inconclusive', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('target', 'TEXT')])]));
    const api = new ProjectionApi(root, (call, fallback) => {
      if (call.depth === 3) throw new FigmaApiError('too_large', 0, 'bounded read exceeded');
      return fallback();
    });

    const out = await resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope'));

    expect(out.threads).toEqual([]);
    expect(out.coverage.filter).toMatchObject({
      complete: false,
      evaluated_threads: 0,
      unresolved_threads: 1,
      count_semantics: 'lower_bound',
      stop_reason: 'metadata_error',
      error: { kind: 'too_large', status: 0 },
    });
    expect(api.fileCalls.map((call) => call.depth)).toEqual([3, 1, 2]);
    expect(api.nodeCalls).toEqual([{ ids: ['target'], depth: 1, version: 'version-one' }]);
  });

  it('propagates programming exceptions from projection reads', async () => {
    const root = document(scene('page', 'CANVAS', [scene('scope', 'FRAME', [scene('target', 'TEXT')])]));
    const api = new ProjectionApi(root, () => { throw new Error('programming fault'); });
    await expect(resolveAnchors(api as unknown as FigmaApi, 'synthetic', [nodeThread('thread', 'target')], scoped('scope')))
      .rejects.toThrow('programming fault');
  });
});

describe('scoped comment application semantics', () => {
  const root = document(scene('page', 'CANVAS', [
    scene('scope', 'FRAME', [scene('inside-a', 'TEXT'), scene('inside-b', 'RECTANGLE')]),
    scene('outside', 'ELLIPSE'),
  ]));
  const comments = [
    rawComment('thread-a', 'inside-a', 'needle first'),
    rawComment('thread-b', 'inside-b', 'second'),
    rawComment('thread-c', 'outside', 'needle outside'),
  ];
  const criteria = { include_resolved: true, include_descendants: true, node_id: 'scope' };

  it('preserves pagination totals while enriching only the selected page', async () => {
    const api = new CommentsProjectionApi(root, comments);
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, {
      file: 'synthetic', criteria, as_markdown: false, node_depth: 0, limit: 1, offset: 1,
    });

    expect(out.total_matching).toBe(2);
    expect(out.page.map((thread) => thread.id)).toEqual(['thread-b']);
    expect(out.page[0].anchor).toMatchObject({ node_name: 'label-inside-b', page_name: 'label-page' });
    expect(out.coverage.enrichment).toMatchObject({ requested_nodes: 1, complete: true });
  });

  it('projects only query-matching candidates before scoped search', async () => {
    const api = new CommentsProjectionApi(root, comments);
    const out = await findThreadsUseCase(api as unknown as FigmaApi, silent, {
      file: 'synthetic', criteria, query: 'needle', fuzzy: false, limit: 10, node_depth: 0,
    });

    expect(out.matches.map((match) => match.thread_id)).toEqual(['thread-a']);
    expect(api.fileCalls[0].ids).toEqual(['inside-a', 'outside']);
    expect(out.coverage.filter).toMatchObject({ complete: true, candidate_threads: 2, evaluated_threads: 2 });
  });

  it('counts scoped summary threads independently when anchors repeat', async () => {
    const repeated = [
      rawComment('thread-a', 'inside-a', 'first'),
      rawComment('thread-b', 'inside-a', 'second'),
      rawComment('thread-c', 'outside', 'third'),
    ];
    const api = new CommentsProjectionApi(root, repeated);
    const out = await summarizeCommentsUseCase(api as unknown as FigmaApi, silent, {
      file: 'synthetic', criteria, node_depth: 0, top_n: 10,
    });

    expect(out.total).toBe(2);
    expect(out.by_anchor.node).toBe(2);
    expect(out.coverage.filter).toMatchObject({ complete: true, candidate_threads: 3, evaluated_threads: 3 });
    expect(api.fileCalls[0].ids).toEqual(['inside-a', 'outside']);
  });
});
