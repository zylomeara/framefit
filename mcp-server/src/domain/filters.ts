import type { Thread, FilterCriteria } from './types.js';
import type { FileStructure } from './file-structure.js';
import { collectDescendants } from './file-structure.js';

/** Filters that require no Figma document metadata. */
export function applyPureFilters(threads: Thread[], criteria: FilterCriteria): Thread[] {
  const sinceMs = criteria.since ? Date.parse(criteria.since) : null;
  const untilMs = criteria.until ? Date.parse(criteria.until) : null;
  const messageLower = criteria.message_contains?.toLowerCase();

  return threads.filter((t) => {
    if (!criteria.include_resolved && t.resolved) return false;

    if (criteria.node_id && !criteria.include_descendants) {
      const anchor = t.anchor;
      if ((anchor.kind !== 'node' && anchor.kind !== 'node_region') || anchor.node_id !== criteria.node_id) return false;
    }

    if (criteria.author_id) {
      if (t.root.author.id !== criteria.author_id) return false;
    } else if (criteria.author_handle) {
      if (t.root.author.handle !== criteria.author_handle) return false;
    }

    if (messageLower) {
      const inRoot = t.root.message.toLowerCase().includes(messageLower);
      const inReply = t.replies.some((r) => r.message.toLowerCase().includes(messageLower));
      if (!inRoot && !inReply) return false;
    }

    if (sinceMs !== null || untilMs !== null) {
      const rootMs = Date.parse(t.root.created_at);
      if (sinceMs !== null && rootMs < sinceMs) return false;
      if (untilMs !== null && rootMs > untilMs) return false;
    }

    if (criteria.min_replies !== undefined && t.replies.length < criteria.min_replies) return false;
    if (criteria.min_reactions !== undefined && t.root.reactions_count < criteria.min_reactions) return false;

    if (criteria.has_mentions === true) {
      const rootHas = t.root.mentions.length > 0;
      const replyHas = t.replies.some((r) => r.mentions.length > 0);
      if (!rootHas && !replyHas) return false;
    }

    return true;
  });
}

/** Legacy complete filter for callers that already hold a complete structure. */
export function applyFilters(
  threads: Thread[],
  criteria: FilterCriteria,
  structure: FileStructure | null,
): Thread[] {
  let nodeIdSet: Set<string> | null = null;
  if (criteria.node_id && criteria.include_descendants && structure) {
    nodeIdSet = collectDescendants(structure, criteria.node_id);
  }

  return applyPureFilters(threads, criteria).filter((t) => {
    if (criteria.node_id && criteria.include_descendants) {
      const anchor = t.anchor;
      if (anchor.kind !== 'node' && anchor.kind !== 'node_region') return false;
      if (nodeIdSet ? !nodeIdSet.has(anchor.node_id) : anchor.node_id !== criteria.node_id) return false;
    }

    if (criteria.node_type) {
      const anchor = t.anchor;
      if (anchor.kind !== 'node' && anchor.kind !== 'node_region') return false;
      const node = structure?.nodeById.get(anchor.node_id);
      if (!node || node.type !== criteria.node_type) return false;
    }

    return true;
  });
}
