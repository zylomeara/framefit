import type { Logger } from '../infrastructure/logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import { parseFileKey } from '../domain/parse-file-key.js';
import { groupThreads } from '../domain/group-threads.js';
import { applyPureFilters } from '../domain/filters.js';
import { summarizeThreads } from '../domain/summary.js';
import { resolveAnchors } from './resolve-anchors.js';
import type { FilterCriteria, SummarizeOutput, CommentsCoverage } from '../domain/types.js';

export type SummarizeInput = {
  file: string;
  criteria: FilterCriteria;
  node_depth: number;
  top_n: number;
  deadlineAt?: number;
};

export type SummarizeCommentsResult = SummarizeOutput & { coverage: CommentsCoverage };

export async function summarizeCommentsUseCase(
  api: FigmaApi,
  logger: Logger,
  input: SummarizeInput,
): Promise<SummarizeCommentsResult> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;

  if (input.criteria.since && input.criteria.until && input.criteria.since > input.criteria.until) {
    throw new Error('since must be <= until');
  }

  logger.info({ tool: 'summarize_comments', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.getComments(fileKey);
  const grouped = groupThreads(raw);
  const prefiltered = applyPureFilters(grouped, input.criteria);
  const resolved = await resolveAnchors(api, fileKey, prefiltered, {
    node_id: input.criteria.node_id,
    include_descendants: input.criteria.include_descendants,
    node_type: input.criteria.node_type,
    node_depth: input.node_depth,
    deadlineAt: input.deadlineAt,
  }, (threads) => {
    const preliminary = summarizeThreads(threads, { top_n: input.top_n });
    const topNodeIds = new Set(preliminary.by_top_nodes.map((node) => node.node_id));
    const topThreadIds = new Set(preliminary.top_threads_by_replies.map((thread) => thread.thread_id));
    return threads.filter((thread) => {
      const anchor = thread.anchor;
      return topThreadIds.has(thread.id)
        || ((anchor.kind === 'node' || anchor.kind === 'node_region') && topNodeIds.has(anchor.node_id));
    });
  });
  const summary = summarizeThreads(resolved.threads, { top_n: input.top_n });

  logger.info({ tool: 'summarize_comments', total: summary.total }, 'use_case.done');
  return { ...summary, coverage: resolved.coverage };
}
