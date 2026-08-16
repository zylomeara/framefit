import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('keeps character semantics by default and uses UTF-8 bytes only when requested', () => {
    const items = ['é', 'a'];

    expect(clampToBudget(items, 2, ser)).toEqual({
      kind: 'fit',
      kept: items,
      serialized: 'éa',
    });
    expect(clampToBudget(items, 2, ser, (text) => Buffer.byteLength(text, 'utf8'))).toEqual({
      kind: 'truncated',
      kept: ['é'],
      serialized: 'é',
    });
    expect(clampToBudget(['é'], 1, ser, (text) => Buffer.byteLength(text, 'utf8'))).toEqual({
      kind: 'first_item_oversize',
    });
  });

  it('uses UTF-8 bytes at the literal pretty boundary when requested', () => {
    const previous = process.env.MCP_PRETTY_JSON;
    process.env.MCP_PRETTY_JSON = 'true';
    try {
      const items = [{ value: '界' }, { value: '界' }];
      const serialize = (xs: typeof items) => serializeForDelivery({ items: xs });
      const full = serialize(items);
      const first = serialize(items.slice(0, 1));
      const measure = (text: string) => Buffer.byteLength(text, 'utf8');

      expect(clampToBudget(items, measure(full), serialize, measure)).toEqual({
        kind: 'fit',
        kept: items,
        serialized: full,
      });
      expect(measure(first)).toBeLessThan(measure(full) - 1);
      expect(clampToBudget(items, measure(full) - 1, serialize, measure)).toEqual({
        kind: 'truncated',
        kept: items.slice(0, 1),
        serialized: first,
      });
    } finally {
      if (previous === undefined) delete process.env.MCP_PRETTY_JSON;
      else process.env.MCP_PRETTY_JSON = previous;
    }
  });

  it('documents honest reason-specific remediation for fixed response limits', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const docs = readFileSync(path.join(repoRoot, 'docs/tools/design-qa.md'), 'utf8');
    const catalog = readFileSync(path.join(repoRoot, 'docs/tools/README.md'), 'utf8');
    const section = (tool: string) => {
      const start = docs.indexOf(`### ${tool}`);
      const end = docs.indexOf('\n### ', start + 1);
      return docs.slice(start, end === -1 ? undefined : end);
    };
    const layout = section('get_layout_spec');
    const view = section('get_view');

    expect(layout).toMatch(
      /`first_item_oversize` means the first retained entry plus required omitted-suffix\s+metadata cannot fit/,
    );
    expect(layout).toMatch(/The entry may fit when replayed alone/);
    expect(layout).toMatch(/`file`, `omitted_node_ids`, and\s+extractor[^.]*guidance/);
    expect(layout).toMatch(/retry without\s+`include_extractor` or with fewer `node_ids`/);

    expect(view).toContain('`envelope_oversize`');
    expect(view).toMatch(/`file`, `node_id`, `effective_max_depth`,\s+and `hydration`/);
    expect(view).toMatch(
      /Retry with lower `max_depth` first\s+because the depth-dependent hydration receipt may shrink/,
    );

    expect(catalog).toMatch(/layout first-prefix\s+probe[^.]*omission metadata/);
    expect(catalog).toMatch(/view\s+envelope[^.]*depth-dependent hydration/);

    expect(layout).not.toContain('If even the first complete entry cannot fit');
    expect(layout).not.toMatch(
      /`first_item_oversize` means the first retained entry (?:alone |itself )?cannot fit\./,
    );
    expect(`${layout}\n${view}\n${catalog}`).not.toContain(
      '`envelope_oversize` means only `file` causes overflow.',
    );
    expect(view).not.toContain(
      'If both are already correct, this request cannot be represented under the fixed limit.',
    );
    expect(catalog).not.toContain(
      'Either tool returns the same static error when its first atomic item or its fixed envelope cannot fit.',
    );
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
