import type { FigmaApi } from '../ports/figma-api.js';
import { FigmaApiError, TOO_LARGE_REASON_RE } from '../ports/errors.js';
import type { Thread, CommentsCoverage, CommentsCoverageError } from '../domain/types.js';
import type { RawFileResponse, RawNodesResponse, RawSceneNode } from '../domain/figma-raw.js';

const MAX_METADATA_CALLS = 16;
const MAX_VISITED_NODES = 10_000;
const BATCH_SIZE = 50;
const INITIAL_PROJECTION_DEPTH = 3;

type NodeMeta = {
  name: string;
  type: string;
  pageName: string;
};

type MetadataStop = { reason: string; error?: CommentsCoverageError };
type Match = true | false | 'unknown';
type PathRef = { id: string; parent?: PathRef };
type ProjectionResult = { found: Set<string>; omitted: Set<string> };

export type AnchorResolveOpts = {
  node_id?: string;
  include_descendants: boolean;
  node_type?: string;
  // Kept for wire compatibility. Metadata reads use the minimum useful depth.
  node_depth: number;
  deadlineAt?: number;
};

export type ResolveAnchorsResult = {
  threads: Thread[];
  coverage: CommentsCoverage;
};

function coverageError(error: FigmaApiError): CommentsCoverageError {
  return {
    kind: error.kind,
    status: error.status,
    ...(error.retryAfterSec === undefined ? {} : { retry_after_sec: error.retryAfterSec }),
  };
}

function isTooLarge(error: FigmaApiError): boolean {
  return error.kind === 'too_large'
    || (error.kind === 'unknown_4xx'
      && error.status === 400
      && TOO_LARGE_REASON_RE.test(error.upstreamReason ?? ''));
}

function pathKey(path: PathRef): string {
  const ids: string[] = [];
  for (let cursor: PathRef | undefined = path; cursor; cursor = cursor.parent) ids.push(cursor.id);
  return ids.reverse().join('/');
}

export async function resolveAnchors(
  api: FigmaApi,
  fileKey: string,
  candidates: Thread[],
  opts: AnchorResolveOpts,
  selectForEnrichment: (threads: Thread[]) => Thread[] = (threads) => threads,
): Promise<ResolveAnchorsResult> {
  const nodes = new Map<string, NodeMeta>();
  const membership = new Map<string, Match>();
  let metadataCalls = 0;
  let visitedNodes = 0;
  let version: string | undefined;
  let stop: MetadataStop | undefined;

  const halt = (reason: string, error?: CommentsCoverageError): void => {
    stop ??= { reason, error };
  };

  const deadlineReached = (): boolean => {
    if (opts.deadlineAt === undefined || Date.now() < opts.deadlineAt) return false;
    halt('deadline');
    return true;
  };

  const canCall = (): boolean => {
    if (deadlineReached()) return false;
    if (metadataCalls >= MAX_METADATA_CALLS) {
      halt('metadata_call_cap');
      return false;
    }
    return true;
  };

  const hasDescendantScope = Boolean(opts.node_id && opts.include_descendants);
  const scopeId = hasDescendantScope ? opts.node_id! : undefined;
  let scopeProven = false;

  const indexMeta = (raw: RawSceneNode, pageName = ''): boolean => {
    if (deadlineReached()) return false;
    const id = raw.id;
    if (deadlineReached()) return false;
    const name = raw.name;
    if (deadlineReached()) return false;
    const type = raw.type;
    if (deadlineReached() || typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') return false;
    const prior = nodes.get(id);
    nodes.set(id, {
      name,
      type,
      pageName: pageName || (type === 'CANVAS' ? name : prior?.pageName || ''),
    });
    return true;
  };

  const scanProjection = (document: RawSceneNode, targetIds: Set<string>): ProjectionResult => {
    type Entry = { node: RawSceneNode; parent?: PathRef; inScope: boolean; pageName: string };
    type SeenTarget = { path: string; member: boolean; conflict: boolean };

    const seen = new Map<string, SeenTarget>();
    const priorScopeProven = scopeProven;
    const priorNodes = new Map<string, NodeMeta | undefined>();
    for (const id of targetIds) priorNodes.set(id, nodes.get(id));
    if (scopeId !== undefined) priorNodes.set(scopeId, nodes.get(scopeId));
    let scopePath: string | undefined;
    let scopeConflict = false;
    const queue: Entry[] = [];
    let queueIndex = 0;
    let capped = false;

    const enqueue = (entry: Entry): boolean => {
      if (deadlineReached()) return false;
      if (visitedNodes >= MAX_VISITED_NODES) {
        capped = true;
        halt('node_visit_cap');
        return false;
      }
      visitedNodes++;
      queue.push(entry);
      return true;
    };

    enqueue({ node: document, inScope: false, pageName: '' });
    while (queueIndex < queue.length) {
      if (deadlineReached()) break;
      const { node, parent, inScope, pageName } = queue[queueIndex++];
      if (typeof node !== 'object' || node === null || Array.isArray(node)) {
        halt('unknown_scope');
        break;
      }
      const id = node.id;
      if (deadlineReached()) break;
      const name = node.name;
      if (deadlineReached()) break;
      const type = node.type;
      if (deadlineReached()) break;
      if (typeof id !== 'string' || typeof name !== 'string' || typeof type !== 'string') continue;

      const path: PathRef = { id, parent };
      const nextPageName = type === 'CANVAS' ? name : pageName;
      const nextInScope = inScope || id === scopeId;

      if (id === scopeId) {
        const currentPath = pathKey(path);
        if (scopePath !== undefined && scopePath !== currentPath) {
          scopeConflict = true;
          halt('unknown_scope');
          break;
        }
        scopePath = currentPath;
        if (!indexMeta(node, nextPageName)) break;
        scopeProven = true;
      }

      if (targetIds.has(id)) {
        if (!indexMeta(node, nextPageName)) break;
        const currentPath = pathKey(path);
        const prior = seen.get(id);
        if (!prior) {
          seen.set(id, { path: currentPath, member: nextInScope, conflict: false });
        } else if (prior.path !== currentPath || prior.member !== nextInScope) {
          prior.conflict = true;
        }
        // The target's ancestor path is complete. Its descendants cannot change membership.
        continue;
      }

      if (deadlineReached()) break;
      const children = node.children;
      if (!Array.isArray(children)) continue;
      for (let index = 0; index < children.length; index++) {
        if (!enqueue({ node: children[index], parent: path, inScope: nextInScope, pageName: nextPageName })) break;
      }
    }

    if (scopeConflict) {
      scopeProven = priorScopeProven;
      for (const [id, prior] of priorNodes) {
        if (prior) nodes.set(id, prior);
        else nodes.delete(id);
      }
      return { found: new Set(), omitted: new Set(targetIds) };
    }

    const found = new Set<string>();
    for (const [id, result] of seen) {
      found.add(id);
      membership.set(id, result.conflict ? 'unknown' : result.member);
    }
    if (capped) {
      for (const id of targetIds) {
        if (!found.has(id)) membership.set(id, 'unknown');
      }
    }
    return { found, omitted: new Set([...targetIds].filter((id) => !found.has(id))) };
  };

  const validateProjection = (raw: RawFileResponse, expectedVersion: string | undefined): boolean => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)
      || typeof raw.version !== 'string' || raw.version.length === 0 || raw.document?.type !== 'DOCUMENT') {
      halt('unknown_scope');
      return false;
    }
    if (expectedVersion !== undefined && raw.version !== expectedVersion) {
      halt('unknown_scope');
      return false;
    }
    version ??= raw.version;
    return raw.version === version;
  };

  const attemptedProjection = new Set<string>();
  const deferredProjectionErrors = new Map<string, CommentsCoverageError>();
  const projectBatch = async (
    ids: string[],
    depth: number,
    allowShallowRecovery = true,
  ): Promise<ProjectionResult> => {
    const empty = (): ProjectionResult => ({ found: new Set(), omitted: new Set(ids) });
    if (ids.length === 0 || stop) return empty();
    if (!canCall()) return empty();

    const expectedVersion = version;
    const attemptKey = `${expectedVersion ?? 'fresh'}\0${depth}\0${ids.join('\0')}`;
    if (attemptedProjection.has(attemptKey)) return empty();
    attemptedProjection.add(attemptKey);
    metadataCalls++;

    try {
      const raw = await api.getDocumentByIdsRaw(fileKey, ids, depth, expectedVersion);
      if (deadlineReached() || !validateProjection(raw, expectedVersion)) return empty();
      return scanProjection(raw.document, new Set(ids));
    } catch (error) {
      if (!(error instanceof FigmaApiError)) throw error;
      if (isTooLarge(error)) {
        if (ids.length > 1) {
          const midpoint = Math.ceil(ids.length / 2);
          const left = await projectBatch(ids.slice(0, midpoint), depth, allowShallowRecovery);
          const right = await projectBatch(ids.slice(midpoint), depth, allowShallowRecovery);
          return {
            found: new Set([...left.found, ...right.found]),
            omitted: new Set([...left.omitted, ...right.omitted]),
          };
        }
        if (allowShallowRecovery && depth > 1) {
          let recovered: ProjectionResult | undefined;
          for (let shallow = 1; shallow < depth && !stop; shallow++) {
            const result = await projectBatch(ids, shallow, false);
            if (stop) return result;
            recovered = result;
            if (result.found.size > 0) return result;
          }
          if (recovered) {
            deferredProjectionErrors.set(ids[0], coverageError(error));
            return recovered;
          }
        }
      }
      halt('metadata_error', coverageError(error));
      return empty();
    }
  };

  const nodeResponseValid = (raw: unknown, expectedVersion?: string): raw is RawNodesResponse => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      halt('unknown_scope');
      return false;
    }
    const candidate = raw as { version?: unknown; nodes?: unknown };
    if (typeof candidate.nodes !== 'object' || candidate.nodes === null || Array.isArray(candidate.nodes)) {
      halt('unknown_scope');
      return false;
    }
    if (expectedVersion !== undefined && candidate.version !== expectedVersion) {
      halt('unknown_scope');
      return false;
    }
    return true;
  };

  const fetchNodeBatch = async (ids: string[], expectedVersion?: string): Promise<RawNodesResponse | undefined> => {
    if (ids.length === 0 || stop) return undefined;
    if (!canCall()) return undefined;
    metadataCalls++;
    try {
      const raw = await api.getNodesRaw(fileKey, ids, 1, expectedVersion);
      if (deadlineReached()) return undefined;
      return nodeResponseValid(raw, expectedVersion) ? raw : undefined;
    } catch (error) {
      if (!(error instanceof FigmaApiError)) throw error;
      if (isTooLarge(error) && ids.length > 1) {
        const midpoint = Math.ceil(ids.length / 2);
        const left = await fetchNodeBatch(ids.slice(0, midpoint), expectedVersion);
        const right = await fetchNodeBatch(ids.slice(midpoint), expectedVersion);
        if (!left) return right;
        if (!right) return left;
        const mergedVersion = expectedVersion ?? (left.version === right.version ? left.version : undefined);
        return {
          ...(mergedVersion === undefined ? {} : { version: mergedVersion }),
          nodes: { ...left.nodes, ...right.nodes },
        };
      }
      halt('metadata_error', coverageError(error));
      return undefined;
    }
  };

  const ancestryIds = hasDescendantScope
    ? [...new Set(candidates.flatMap((thread) => {
      const anchor = thread.anchor;
      return (anchor.kind === 'node' || anchor.kind === 'node_region') && anchor.node_id !== scopeId
        ? [anchor.node_id]
        : [];
    }))]
    : [];

  if (hasDescendantScope) {
    membership.set(scopeId!, true);
    const omitted = new Set<string>();

    for (let start = 0; start < ancestryIds.length && !stop; start += BATCH_SIZE) {
      const batch = ancestryIds.slice(start, start + BATCH_SIZE);
      const result = await projectBatch(batch, INITIAL_PROJECTION_DEPTH);
      for (const id of result.omitted) omitted.add(id);
    }
    if (stop) {
      for (const id of ancestryIds) membership.set(id, membership.get(id) ?? 'unknown');
    }

    const knownPresent = new Set<string>();
    const provenAbsent = new Set<string>();
    if (version && !stop && (omitted.size > 0 || !scopeProven)) {
      const checks = [...omitted];
      if (!scopeProven) checks.push(scopeId!);
      for (let start = 0; start < checks.length && !stop; start += BATCH_SIZE) {
        const batch = checks.slice(start, start + BATCH_SIZE);
        const raw = await fetchNodeBatch(batch, version);
        if (!raw) break;
        for (const id of batch) {
          if (deadlineReached()) break;
          if (!Object.hasOwn(raw.nodes, id)) continue;
          const entry = raw.nodes[id];
          if (deadlineReached()) break;
          if (entry === null) {
            if (id !== scopeId) {
              provenAbsent.add(id);
              deferredProjectionErrors.delete(id);
            }
            continue;
          }
          const document = entry?.document;
          if (!document || document.id !== id || !indexMeta(document)) continue;
          if (id === scopeId) scopeProven = true;
          else knownPresent.add(id);
        }
      }
    }

    if (deferredProjectionErrors.size > 0 && !stop) {
      stop = { reason: 'metadata_error', error: deferredProjectionErrors.values().next().value };
    }
    if (ancestryIds.length > 0 && !scopeProven && !stop) halt('scope_root_missing');

    for (const id of provenAbsent) membership.set(id, scopeProven ? false : 'unknown');
    if (!stop) {
      let unresolved = [...knownPresent];
      for (let depth = INITIAL_PROJECTION_DEPTH + 1; unresolved.length > 0 && !stop; depth++) {
        const next: string[] = [];
        for (let start = 0; start < unresolved.length && !stop; start += BATCH_SIZE) {
          const batch = unresolved.slice(start, start + BATCH_SIZE);
          const result = await projectBatch(batch, depth);
          for (const id of result.omitted) next.push(id);
        }
        unresolved = next;
      }
      for (const id of unresolved) membership.set(id, 'unknown');
    }

    for (const id of ancestryIds) {
      const current = membership.get(id);
      if (current === false && !scopeProven) membership.set(id, 'unknown');
      else if (current === undefined) membership.set(id, 'unknown');
    }
  }

  const hasTypeFilter = Boolean(opts.node_type);
  const needsStructuralFilter = hasDescendantScope || hasTypeFilter;
  const typeIds = new Set<string>();
  if (hasTypeFilter) {
    for (const thread of candidates) {
      const anchor = thread.anchor;
      if (anchor.kind !== 'node' && anchor.kind !== 'node_region') continue;
      if (hasDescendantScope && membership.get(anchor.node_id) !== true) continue;
      if (!nodes.has(anchor.node_id)) typeIds.add(anchor.node_id);
    }
    const ids = [...typeIds];
    for (let start = 0; start < ids.length && !stop; start += BATCH_SIZE) {
      const batch = ids.slice(start, start + BATCH_SIZE);
      const raw = await fetchNodeBatch(batch, version);
      if (!raw) break;
      for (const id of batch) {
        if (deadlineReached()) break;
        if (!Object.hasOwn(raw.nodes, id)) continue;
        const document = raw.nodes[id]?.document;
        if (document?.id === id) indexMeta(document);
      }
    }
  }

  const classified = candidates.map((thread) => {
    const anchor = thread.anchor;
    const isNode = anchor.kind === 'node' || anchor.kind === 'node_region';
    if (hasDescendantScope) {
      if (!isNode) return { thread, match: false as const };
      const relation = membership.get(anchor.node_id) ?? 'unknown';
      if (relation !== true) return { thread, match: relation };
    }
    if (hasTypeFilter) {
      if (!isNode) return { thread, match: false as const };
      const node = nodes.get(anchor.node_id);
      if (!node) return { thread, match: 'unknown' as const };
      if (node.type !== opts.node_type) return { thread, match: false as const };
    }
    return { thread, match: true as const };
  });

  const matched = needsStructuralFilter
    ? classified.filter((entry) => entry.match === true).map((entry) => entry.thread)
    : candidates;
  const unresolvedThreads = needsStructuralFilter
    ? classified.filter((entry) => entry.match === 'unknown').length
    : 0;

  const selectedIds = new Set(selectForEnrichment(matched).map((thread) => thread.id));
  const requestedNodeIds = [...new Set(
    matched.flatMap((thread) => {
      if (!selectedIds.has(thread.id)) return [];
      const anchor = thread.anchor;
      return anchor.kind === 'node' || anchor.kind === 'node_region' ? [anchor.node_id] : [];
    }),
  )];
  const missingMetadata = requestedNodeIds.filter((id) => !nodes.has(id));
  for (let start = 0; start < missingMetadata.length && !stop; start += BATCH_SIZE) {
    const batch = missingMetadata.slice(start, start + BATCH_SIZE);
    const raw = await fetchNodeBatch(batch, version);
    if (!raw) break;
    for (const id of batch) {
      if (deadlineReached()) break;
      if (!Object.hasOwn(raw.nodes, id)) continue;
      const document = raw.nodes[id]?.document;
      if (document?.id === id) indexMeta(document);
    }
  }

  const unresolvedNodeIds = requestedNodeIds.filter((id) => {
    const node = nodes.get(id);
    return !node || !node.name || !node.pageName;
  });
  const resolvedNodeNames = requestedNodeIds.filter((id) => Boolean(nodes.get(id)?.name)).length;
  const resolvedPageNames = requestedNodeIds.filter((id) => Boolean(nodes.get(id)?.pageName)).length;
  const enrichmentStop = stop ?? (unresolvedNodeIds.length ? { reason: 'page_name_unavailable' } : undefined);
  const enriched = matched.map((thread) => {
    if (!selectedIds.has(thread.id)) return thread;
    const anchor = thread.anchor;
    if (anchor.kind !== 'node' && anchor.kind !== 'node_region') return thread;
    const node = nodes.get(anchor.node_id);
    if (!node) return thread;
    return { ...thread, anchor: { ...anchor, node_name: node.name, page_name: node.pageName } };
  });

  const filterComplete = unresolvedThreads === 0;
  return {
    threads: enriched,
    coverage: {
      filter: {
        complete: filterComplete,
        candidate_threads: candidates.length,
        evaluated_threads: needsStructuralFilter ? candidates.length - unresolvedThreads : candidates.length,
        unresolved_threads: unresolvedThreads,
        count_semantics: filterComplete ? 'exact' : 'lower_bound',
        ...(filterComplete || !stop ? {} : { stop_reason: stop.reason }),
        ...(filterComplete || !stop?.error ? {} : { error: stop.error }),
      },
      enrichment: {
        complete: unresolvedNodeIds.length === 0,
        requested_nodes: requestedNodeIds.length,
        resolved_node_names: resolvedNodeNames,
        resolved_page_names: resolvedPageNames,
        unresolved_node_ids: unresolvedNodeIds.slice(0, 20),
        unresolved_node_ids_total: unresolvedNodeIds.length,
        ...(enrichmentStop ? { stop_reason: enrichmentStop.reason } : {}),
        ...(enrichmentStop?.error ? { error: enrichmentStop.error } : {}),
      },
    },
  };
}
