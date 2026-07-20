import type { Logger } from '../infrastructure/logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import { parseFileKey } from '../domain/parse-file-key.js';
import { groupThreads } from '../domain/group-threads.js';
import { applyFilters } from '../domain/filters.js';
import { findThreadsByQuery } from '../domain/find.js';
import { resolveAnchors } from './resolve-anchors.js';
import type { FilterCriteria, MatchedThread } from '../domain/types.js';

export type FindThreadsInput = {
  file: string;
  criteria: FilterCriteria;
  query: string;
  fuzzy: boolean;
  limit: number;
  node_depth: number;
};

export type FindThreadsOutput = { query: string; matches: MatchedThread[] };

export async function findThreadsUseCase(
  api: FigmaApi,
  logger: Logger,
  input: FindThreadsInput,
): Promise<FindThreadsOutput> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;

  if (input.criteria.since && input.criteria.until && input.criteria.since > input.criteria.until) {
    throw new Error('since must be <= until');
  }

  logger.info({ tool: 'find_threads', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.getComments(fileKey);
  const grouped = groupThreads(raw);
  const { threads: enriched, structure } = await resolveAnchors(api, fileKey, grouped, {
    include_descendants: input.criteria.include_descendants,
    node_type: input.criteria.node_type,
    node_depth: input.node_depth,
  });
  const filtered = applyFilters(enriched, input.criteria, structure);
  const matches = findThreadsByQuery(filtered, input.query, input.limit, { fuzzy: input.fuzzy });

  logger.info({ tool: 'find_threads', match_count: matches.length }, 'use_case.done');
  return { query: input.query, matches };
}
