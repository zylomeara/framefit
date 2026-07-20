import type { Logger } from '../infrastructure/logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import { parseFileKey } from '../domain/parse-file-key.js';
import { groupThreads } from '../domain/group-threads.js';
import { applyFilters } from '../domain/filters.js';
import { resolveAnchors } from './resolve-anchors.js';
import type { Thread, FilterCriteria } from '../domain/types.js';

export type GetCommentsInput = {
  file: string;
  criteria: FilterCriteria;
  as_markdown: boolean;
  node_depth: number;
  limit: number;
  offset: number;
};

export type Warning = { code: string; message: string };

// The use case lives on the application side of the hexagonal boundary — it has no visibility
// into serializeForDelivery / the wire header, so it does NOT clamp. It returns the full
// requested page plus the counts the tool layer needs to clamp + build warnings itself.
export type GetCommentsResult = {
  page: Thread[];
  total_matching: number;
  offset: number;
};

export function clampToBudget<T>(
  items: T[],
  budget: number,
  serialize: (xs: T[]) => string,
): { kept: T[]; clamped: boolean } {
  if (items.length === 0) return { kept: items, clamped: false };
  if (serialize(items).length <= budget) return { kept: items, clamped: false };
  // Largest prefix that fits the budget (at least 1 item).
  let lo = 1;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serialize(items.slice(0, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { kept: items.slice(0, lo), clamped: lo < items.length };
}

export function computeWarnings(a: {
  total_matching: number;
  next_offset: number | null;
  payload_size: number;
  budget: number;
  clamped: boolean;
}): Warning[] {
  const warnings: Warning[] = [];
  if (a.next_offset !== null) {
    warnings.push({
      code: 'more_available',
      message: `More threads available — pass offset=${a.next_offset} for the next page.`,
    });
  }
  if (a.total_matching > 500) {
    warnings.push({
      code: 'broad_filter',
      message: `${a.total_matching} threads match — narrow the filters or use summarize_comments first.`,
    });
  }
  if (a.clamped) {
    warnings.push({
      code: 'auto_clamped',
      message: `Result truncated to fit the transport budget (~${Math.round(a.budget / 1024)}KB). Returned fewer threads than requested — paginate with next_offset, narrow filters, use summarize_comments, or as_markdown=true.`,
    });
  } else if (a.payload_size > a.budget * 0.75) {
    warnings.push({
      code: 'large_result',
      message: `Result is ~${Math.round(a.payload_size / 1024)}KB, near the transport limit — consider summarize_comments first, narrower filters, or as_markdown=true.`,
    });
  }
  return warnings;
}

export async function getCommentsUseCase(
  api: FigmaApi,
  logger: Logger,
  input: GetCommentsInput,
): Promise<GetCommentsResult> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;

  if (input.criteria.since && input.criteria.until && input.criteria.since > input.criteria.until) {
    throw new Error('since must be <= until');
  }

  logger.info({ tool: 'get_comments', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.getComments(fileKey);
  const grouped = groupThreads(raw);

  const { threads: enriched, structure } = await resolveAnchors(api, fileKey, grouped, {
    include_descendants: input.criteria.include_descendants,
    node_type: input.criteria.node_type,
    node_depth: input.node_depth,
  });

  const filtered = applyFilters(enriched, input.criteria, structure);
  const page = filtered.slice(input.offset, input.offset + input.limit);

  logger.info(
    { tool: 'get_comments', total_matching: filtered.length, returned: page.length },
    'use_case.done',
  );

  // No clamp here: the tool layer measures the DELIVERED serialization (per-branch: plain-text
  // markdown vs the JSON envelope through serializeForDelivery) and computes warnings.
  return { page, total_matching: filtered.length, offset: input.offset };
}
