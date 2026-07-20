import { describe, it, expect } from 'vitest';
import { summarizeThreads } from '../../src/domain/summary.js';
import type { Thread, CommentInThread } from '../../src/domain/types.js';

function c(over: Partial<CommentInThread> = {}): CommentInThread {
  return { id: 'c', author: { id: 'u', handle: 'A' }, created_at: '2026-05-15T00:00:00Z', message: 'm', mentions: [], reactions_count: 0, ...over };
}
function t(over: Partial<Thread> = {}): Thread {
  return { id: 't', kind: 'single', resolved: false, anchor: { kind: 'canvas_point', x: 0, y: 0 }, root: c(), replies: [], ...over };
}

describe('summarizeThreads', () => {
  it('counts total/open/resolved', () => {
    const s = summarizeThreads([t({ id: '1' }), t({ id: '2', resolved: true })], { top_n: 10 });
    expect(s.total).toBe(2);
    expect(s.open).toBe(1);
    expect(s.resolved).toBe(1);
  });

  it('by_author sorted desc with open/resolved split', () => {
    const s = summarizeThreads(
      [
        t({ id: '1', root: c({ author: { id: 'a', handle: 'Anna' } }) }),
        t({ id: '2', root: c({ author: { id: 'a', handle: 'Anna' } }), resolved: true }),
        t({ id: '3', root: c({ author: { id: 'b', handle: 'Bob' } }) }),
      ],
      { top_n: 10 },
    );
    expect(s.by_author[0]).toEqual({ author_id: 'a', author_handle: 'Anna', total: 2, open: 1, resolved: 1 });
    expect(s.by_author[1].author_id).toBe('b');
  });

  it('by_anchor counts all 4 kinds; sum equals total', () => {
    const s = summarizeThreads(
      [
        t({ id: '1', anchor: { kind: 'canvas_point', x: 0, y: 0 } }),
        t({ id: '2', anchor: { kind: 'node', node_id: '1:1', node_name: 'N', page_name: 'P', offset: { x: 0, y: 0 } } }),
      ],
      { top_n: 10 },
    );
    expect(s.by_anchor.canvas_point).toBe(1);
    expect(s.by_anchor.node).toBe(1);
    const sum = s.by_anchor.canvas_point + s.by_anchor.canvas_region + s.by_anchor.node + s.by_anchor.node_region;
    expect(sum).toBe(s.total);
  });

  it('by_top_nodes respects top_n and sorts desc', () => {
    const mk = (id: string, nodeId: string) => t({ id, anchor: { kind: 'node', node_id: nodeId, node_name: 'N' + nodeId, page_name: 'P', offset: { x: 0, y: 0 } } });
    const threads = [mk('1', '1:1'), mk('2', '1:1'), mk('3', '1:2')];
    const s = summarizeThreads(threads, { top_n: 1 });
    expect(s.by_top_nodes).toHaveLength(1);
    expect(s.by_top_nodes[0]).toMatchObject({ node_id: '1:1', count: 2 });
  });

  it('top_threads_by_replies empty when no replies', () => {
    const s = summarizeThreads([t({ id: '1' })], { top_n: 10 });
    expect(s.top_threads_by_replies).toEqual([]);
  });

  it('by_date groups by ISO week sorted asc', () => {
    const s = summarizeThreads(
      [
        t({ id: '1', root: c({ created_at: '2026-05-15T00:00:00Z' }) }),
        t({ id: '2', root: c({ created_at: '2026-05-04T00:00:00Z' }) }),
      ],
      { top_n: 10 },
    );
    expect(s.by_date.map((d) => d.week)).toEqual(['2026-W19', '2026-W20']);
  });

  it('with_mentions counts root or reply mentions', () => {
    const s = summarizeThreads(
      [
        t({ id: '1', root: c({ mentions: ['x'] }) }),
        t({ id: '2', kind: 'thread', replies: [c({ mentions: ['y'] })] }),
        t({ id: '3' }),
      ],
      { top_n: 10 },
    );
    expect(s.with_mentions).toBe(2);
  });
});
