import { describe, it, expect } from 'vitest';
import { formatMarkdown } from '../../src/domain/format-markdown.js';
import type { Thread, CommentInThread } from '../../src/domain/types.js';

const baseRoot: CommentInThread = {
  id: 'r1',
  author: { id: 'u1', handle: 'Анна' },
  created_at: '2026-05-15T11:42:00Z',
  message: 'hello',
  mentions: [],
  reactions_count: 0,
};

function thread(anchor: Thread['anchor'], overrides: Partial<Thread> = {}): Thread {
  return { id: 'r1', kind: 'single', resolved: false, anchor, root: baseRoot, replies: [], ...overrides };
}

describe('formatMarkdown', () => {
  it('renders canvas_point anchor', () => {
    expect(formatMarkdown([thread({ kind: 'canvas_point', x: 100, y: 200 })])).toContain(
      'pinned to canvas at (100, 200)',
    );
  });

  it('renders node anchor with name, node id, and page', () => {
    const md = formatMarkdown([
      thread({ kind: 'node', node_id: '1:42', node_name: 'Button / Primary', page_name: 'Components', offset: { x: 0, y: 0 } }),
    ]);
    expect(md).toContain('on Button / Primary');
    expect(md).toContain('node: 1:42');
    expect(md).toContain('page: Components');
  });

  it('renders thread header with status and id', () => {
    const md = formatMarkdown([thread({ kind: 'canvas_point', x: 0, y: 0 }, { id: '42', resolved: true })]);
    expect(md).toContain('Thread #42');
    expect(md).toContain('(resolved)');
  });

  it('renders replies indented under root', () => {
    const md = formatMarkdown([
      thread(
        { kind: 'canvas_point', x: 0, y: 0 },
        {
          kind: 'thread',
          replies: [
            { id: 'r2', author: { id: 'u2', handle: 'Петя' }, created_at: '2026-05-15T12:01:00Z', message: 'ok', mentions: [], reactions_count: 0 },
          ],
        },
      ),
    ]);
    expect(md).toMatch(/  ↳ \*\*Петя\*\*/);
  });

  it('falls back to node id when name empty', () => {
    const md = formatMarkdown([
      thread({ kind: 'node', node_id: '1:999', node_name: '', page_name: '', offset: { x: 0, y: 0 } }),
    ]);
    expect(md).toContain('node 1:999');
  });
});
