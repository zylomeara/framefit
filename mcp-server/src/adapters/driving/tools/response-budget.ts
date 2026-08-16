import { serializeForDelivery } from './serialize.js';
import { responseBudgetBlocker } from '../../../domain/layout-spec/verification.js';
import type { PairResult, PairSummary, VerificationReceipt } from '../../../domain/layout-spec/types.js';

export const RESULT_BUDGET_BYTES = 1024 * 1024;

export type ResponseBudgetOverflow = 'first_item_oversize' | 'envelope_oversize';

export type ClampToBudgetResult<T> =
  | { kind: 'fit'; kept: T[]; serialized: string }
  | { kind: 'truncated'; kept: T[]; serialized: string }
  | { kind: 'first_item_oversize' }
  | { kind: 'envelope_oversize' };

export function responseTooLargeResult(reason: ResponseBudgetOverflow) {
  return {
    isError: true as const,
    content: [{
      type: 'text' as const,
      text: serializeForDelivery({ code: 'response_too_large', reason, action: 'narrow_request' }),
    }],
  };
}

export function responseBudgetFallback(
  results: PairResult[],
  receipt: VerificationReceipt,
  reason: ResponseBudgetOverflow,
): Record<string, unknown> {
  const summary: PairSummary = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0, demoted: 0, unchecked: 0, review: 0 };
  for (const result of results) {
    for (const key of Object.keys(summary) as (keyof PairSummary)[]) summary[key] += result.summary[key];
  }
  return {
    code: 'response_budget', reason, pairs: [], summary,
    verification: {
      complete: false, scope: receipt.scope, pairs: receipt.pairs,
      blocking: [responseBudgetBlocker()],
    },
    omitted_pairs: results.length,
    omitted_pair_indices: results.map((_, index) => index),
  };
}

export function clampToBudget<T>(
  items: T[],
  budget: number,
  serialize: (xs: T[]) => string,
  measureSerialized: (serialized: string) => number = (serialized) => serialized.length,
): ClampToBudgetResult<T> {
  const full = serialize(items);
  if (measureSerialized(full) <= budget) return { kind: 'fit', kept: items, serialized: full };

  const empty = serialize([]);
  if (measureSerialized(empty) > budget) return { kind: 'envelope_oversize' };
  if (items.length === 0) return { kind: 'fit', kept: items, serialized: empty };

  const first = serialize(items.slice(0, 1));
  if (measureSerialized(first) > budget) return { kind: 'first_item_oversize' };

  let lo = 1;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measureSerialized(serialize(items.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const kept = items.slice(0, lo);
  return { kind: 'truncated', kept, serialized: serialize(kept) };
}
