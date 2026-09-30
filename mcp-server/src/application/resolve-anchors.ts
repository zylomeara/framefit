import type { FigmaApi } from '../ports/figma-api.js';
import { FigmaApiError } from '../ports/errors.js';
import type { Thread, CommentsCoverage, CommentsCoverageError } from '../domain/types.js';
import type { RawSceneNode } from '../domain/figma-raw.js';

const MAX_METADATA_CALLS = 16;
const MAX_VISITED_NODES = 10_000;
const BATCH_SIZE = 50;

const LEAF_TYPES = new Set([
  'TEXT', 'RECTANGLE', 'VECTOR', 'ELLIPSE', 'LINE', 'REGULAR_POLYGON', 'STAR', 'SLICE',
]);

type NodeMeta = {
  name: string;
  type: string;
  pageName: string;
  children: string[];
  childrenKnown: boolean;
  childrenComplete: boolean;
};

type MetadataStop = { reason: string; error?: CommentsCoverageError };

export type AnchorResolveOpts = {
  node_id?: string;
  include_descendants: boolean;
  node_type?: string;
  // Kept for wire compatibility. All metadata reads deliberately use Figma's minimum depth=1.
  node_depth: number;
  deadlineAt?: number;
};

export type ResolveAnchorsResult = {
  threads: Thread[];
  coverage: CommentsCoverage;
};

export async function resolveAnchors(
  api: FigmaApi,
  fileKey: string,
  candidates: Thread[],
  opts: AnchorResolveOpts,
  selectForEnrichment: (threads: Thread[]) => Thread[] = (threads) => threads,
): Promise<ResolveAnchorsResult> {
  const nodes = new Map<string, NodeMeta>();
  let metadataCalls = 0;
  let stop: MetadataStop | undefined;

  const halt = (reason: string, error?: CommentsCoverageError): void => {
    stop ??= { reason, error };
  };

  const index = (raw: RawSceneNode, fetched: boolean, inheritedPageName = ''): void => {
    const prior = nodes.get(raw.id);
    if (!prior && nodes.size >= MAX_VISITED_NODES) {
      halt('node_visit_cap');
      return;
    }

    const pageName = raw.type === 'CANVAS' ? raw.name : inheritedPageName;
    const reservedRootSlots = prior ? 0 : 1;
    const childrenKnown = fetched && Array.isArray(raw.children);
    const children = childrenKnown ? [] as string[] : prior?.children ?? [];
    let childrenComplete = childrenKnown;
    if (childrenKnown) {
      for (const child of raw.children!) {
        const childPrior = nodes.get(child.id);
        if (!childPrior && nodes.size + reservedRootSlots >= MAX_VISITED_NODES) {
          childrenComplete = false;
          halt('node_visit_cap');
          break;
        }
        children.push(child.id);
        nodes.set(child.id, {
          name: child.name,
          type: child.type,
          pageName: pageName || childPrior?.pageName || '',
          children: childPrior?.children ?? [],
          childrenKnown: childPrior?.childrenKnown === true,
          childrenComplete: childPrior?.childrenComplete === true,
        });
      }
    }

    nodes.set(raw.id, {
      name: raw.name,
      type: raw.type,
      pageName: pageName || prior?.pageName || '',
      children,
      childrenKnown: childrenKnown || prior?.childrenKnown === true,
      childrenComplete: childrenKnown ? childrenComplete : prior?.childrenComplete === true,
    });
  };

  const fetchNodes = async (ids: string[], requireChildren = false): Promise<void> => {
    const unique = [...new Set(ids)].filter((id) => {
      const node = nodes.get(id);
      return !node || (requireChildren && !node.childrenKnown && !LEAF_TYPES.has(node.type));
    });
    for (let start = 0; start < unique.length && !stop; start += BATCH_SIZE) {
      if (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt) {
        halt('deadline');
        break;
      }
      if (metadataCalls >= MAX_METADATA_CALLS) {
        halt('metadata_call_cap');
        break;
      }
      const batch = unique.slice(start, start + BATCH_SIZE);
      metadataCalls++;
      try {
        const raw = await api.getNodesRaw(fileKey, batch, 1);
        for (const id of batch) {
          if ((stop as MetadataStop | undefined)?.reason === 'node_visit_cap') break;
          const document = raw.nodes[id]?.document;
          if (document) index(document, true, nodes.get(id)?.pageName ?? '');
        }
      } catch (error) {
        if (!(error instanceof FigmaApiError)) throw error;
        halt('metadata_error', {
          kind: error.kind,
          status: error.status,
          ...(error.retryAfterSec === undefined ? {} : { retry_after_sec: error.retryAfterSec }),
        });
      }
    }
  };

  const scopeMembers = new Set<string>();
  let scopeComplete = true;
  const hasDescendantScope = Boolean(opts.node_id && opts.include_descendants);
  if (hasDescendantScope) {
    const scopeId = opts.node_id!;
    scopeMembers.add(scopeId);
    const wanted = new Set(
      candidates.flatMap((thread) => {
        const anchor = thread.anchor;
        return (anchor.kind === 'node' || anchor.kind === 'node_region') && anchor.node_id !== scopeId
          ? [anchor.node_id]
          : [];
      }),
    );

    if (wanted.size > 0) {
      const queue = [scopeId];
      const queued = new Set(queue);
      let queueIndex = 0;
      let rootMissing = false;
      let unknownBranch = false;

      while (queueIndex < queue.length && wanted.size > 0 && !stop) {
        const next = queue.slice(queueIndex, queueIndex + BATCH_SIZE);
        queueIndex += next.length;
        await fetchNodes(next, true);
        if (stop && (stop as MetadataStop).reason !== 'node_visit_cap') break;

        for (const id of next) {
          const node = nodes.get(id);
          if (!node) {
            if (id === scopeId) rootMissing = true;
            else unknownBranch = true;
            continue;
          }
          if (!node.childrenKnown) {
            if (!LEAF_TYPES.has(node.type)) unknownBranch = true;
            continue;
          }
          for (const childId of node.children) {
            if (!queued.has(childId)) {
              if (queued.size >= MAX_VISITED_NODES) {
                halt('node_visit_cap');
                break;
              }
              queued.add(childId);
              queue.push(childId);
            }
            if (wanted.delete(childId)) scopeMembers.add(childId);
          }
          if (!node.childrenComplete) unknownBranch = true;
          if (stop || wanted.size === 0) break;
        }
      }

      if (rootMissing) halt('scope_root_missing');
      if (unknownBranch && wanted.size > 0) halt('unknown_scope');
      scopeComplete = wanted.size === 0 || (!stop && !rootMissing && !unknownBranch && queueIndex >= queue.length);
    }
  }

  const hasTypeFilter = Boolean(opts.node_type);
  const needsStructuralFilter = hasDescendantScope || hasTypeFilter;
  const nodeTypeIds = new Set<string>();
  if (hasTypeFilter) {
    for (const thread of candidates) {
      const anchor = thread.anchor;
      if (anchor.kind !== 'node' && anchor.kind !== 'node_region') continue;
      if (hasDescendantScope && !scopeMembers.has(anchor.node_id)) continue;
      nodeTypeIds.add(anchor.node_id);
    }
    await fetchNodes([...nodeTypeIds]);
  }

  const classified = candidates.map((thread) => {
    const anchor = thread.anchor;
    const isNode = anchor.kind === 'node' || anchor.kind === 'node_region';
    if (hasDescendantScope) {
      if (!isNode) return { thread, match: false as const };
      if (!scopeMembers.has(anchor.node_id)) {
        return { thread, match: scopeComplete ? false as const : 'unknown' as const };
      }
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
  await fetchNodes(requestedNodeIds);

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
