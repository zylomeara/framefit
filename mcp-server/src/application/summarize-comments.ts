import type { Logger } from '../infrastructure/logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import { parseFileKey } from '../domain/parse-file-key.js';
import { groupThreads } from '../domain/group-threads.js';
import { applyFilters } from '../domain/filters.js';
import { summarizeThreads } from '../domain/summary.js';
import { resolveAnchors } from './resolve-anchors.js';
import type { FilterCriteria, SummarizeOutput } from '../domain/types.js';

export type SummarizeInput = {
  file: string;
  criteria: FilterCriteria;
  node_depth: number;
  top_n: number;
};

export async function summarizeCommentsUseCase(
  api: FigmaApi,
  logger: Logger,
  input: SummarizeInput,
): Promise<SummarizeOutput> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;

  if (input.criteria.since && input.criteria.until && input.criteria.since > input.criteria.until) {
    throw new Error('since must be <= until');
  }

  logger.info({ tool: 'summarize_comments', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.getComments(fileKey);
  const grouped = groupThreads(raw);
  const { threads: enriched, structure } = await resolveAnchors(api, fileKey, grouped, {
    include_descendants: input.criteria.include_descendants,
    node_type: input.criteria.node_type,
    node_depth: input.node_depth,
  });
  const filtered = applyFilters(enriched, input.criteria, structure);
  const summary = summarizeThreads(filtered, { top_n: input.top_n });

  logger.info({ tool: 'summarize_comments', total: summary.total }, 'use_case.done');
  return summary;
}
