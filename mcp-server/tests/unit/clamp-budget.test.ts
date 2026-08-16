import { describe, it, expect } from 'vitest';
import { clampToBudget, responseTooLargeResult } from '../../src/adapters/driving/tools/response-budget.js';
import { serializeForDelivery } from '../../src/adapters/driving/tools/serialize.js';

const ser = (xs: string[]) => xs.join(''); // each item length = string length

describe('clampToBudget', () => {
  it('returns the exact full serialization when it fits', () => {
    expect(clampToBudget(['aa', 'bb'], 100, ser)).toEqual({
      kind: 'fit',
      kept: ['aa', 'bb'],
      serialized: 'aabb',
    });
  });

  it('returns the largest fitting prefix and its exact serialization', () => {
    // each item 10 chars; budget 25 → only 2 fit (20 <= 25, 30 > 25)
    const items = ['xxxxxxxxxx', 'yyyyyyyyyy', 'zzzzzzzzzz'];
    expect(clampToBudget(items, 25, ser)).toEqual({
      kind: 'truncated',
      kept: items.slice(0, 2),
      serialized: ser(items.slice(0, 2)),
    });
  });

  it('does not retain a first item whose final envelope exceeds the budget', () => {
    expect(clampToBudget(['this-one-item-is-huge'], 5, ser)).toEqual({
      kind: 'first_item_oversize',
    });
  });

  it('distinguishes fixed-envelope overflow from first-item overflow', () => {
    const serialize = (xs: string[]) => `fixed-envelope:${xs.join('')}`;
    expect(clampToBudget(['x'], 5, serialize)).toEqual({
      kind: 'envelope_oversize',
    });
  });

  it('returns an exact fitting empty envelope for empty input', () => {
    expect(clampToBudget([], 100, ser)).toEqual({
      kind: 'fit',
      kept: [],
      serialized: '',
    });
  });

  it('uses the literal pretty serialization at the exact boundary', () => {
    const previous = process.env.MCP_PRETTY_JSON;
    process.env.MCP_PRETTY_JSON = 'true';
    try {
      const items = [{ value: 'one' }, { value: 'two' }];
      const serialize = (xs: typeof items) => serializeForDelivery({ items: xs });
      const full = serialize(items);
      expect(clampToBudget(items, full.length, serialize)).toEqual({
        kind: 'fit',
        kept: items,
        serialized: full,
      });
    } finally {
      if (previous === undefined) delete process.env.MCP_PRETTY_JSON;
      else process.env.MCP_PRETTY_JSON = previous;
    }
  });

  it('serializes the fixed overflow error in the active delivery mode', () => {
    const previous = process.env.MCP_PRETTY_JSON;
    process.env.MCP_PRETTY_JSON = 'true';
    try {
      const value = { code: 'response_too_large', reason: 'first_item_oversize', action: 'narrow_request' };
      expect(responseTooLargeResult('first_item_oversize')).toEqual({
        isError: true,
        content: [{ type: 'text', text: serializeForDelivery(value) }],
      });
    } finally {
      if (previous === undefined) delete process.env.MCP_PRETTY_JSON;
      else process.env.MCP_PRETTY_JSON = previous;
    }
  });
});
