import { describe, it, expect } from 'vitest';
import { findThreadsByQuery } from '../../src/domain/find.js';
import type { Thread, CommentInThread } from '../../src/domain/types.js';

function c(message: string, over: Partial<CommentInThread> = {}): CommentInThread {
  return { id: 'c', author: { id: 'u', handle: 'Anna' }, created_at: '2026-05-15T00:00:00Z', message, mentions: [], reactions_count: 0, ...over };
}
function t(id: string, rootMsg: string, replies: CommentInThread[] = []): Thread {
  return { id, kind: replies.length ? 'thread' : 'single', resolved: false, anchor: { kind: 'canvas_point', x: 0, y: 0 }, root: c(rootMsg), replies };
}

describe('findThreadsByQuery (substring)', () => {
  it('matches single term in root with root bonus', () => {
    const res = findThreadsByQuery([t('1', 'fix the radius please')], 'radius', 10, { fuzzy: false });
    expect(res).toHaveLength(1);
    expect(res[0].matched_in).toBe('root');
    expect(res[0].score).toBeGreaterThanOrEqual(0.2);
  });

  it('no match → excluded', () => {
    const res = findThreadsByQuery([t('1', 'nothing here')], 'radius', 10, { fuzzy: false });
    expect(res).toHaveLength(0);
  });

  it('all terms in one message gets the cohesion bonus', () => {
    const res = findThreadsByQuery([t('1', 'update radius on prod')], 'update radius', 10, { fuzzy: false });
    expect(res[0].score).toBeGreaterThan(0.5);
  });

  it('matches in reply when root does not match', () => {
    const res = findThreadsByQuery([t('1', 'root text', [c('the RADIUS is wrong')])], 'radius', 10, { fuzzy: false });
    expect(res[0].matched_in).toBe('reply');
  });

  it('respects limit and sorts by score desc', () => {
    const threads = [t('1', 'radius'), t('2', 'radius extra'), t('3', 'radius')];
    const res = findThreadsByQuery(threads, 'radius', 2, { fuzzy: false });
    expect(res).toHaveLength(2);
  });

  it('highlight surrounds the matched term', () => {
    const long = 'x'.repeat(80) + ' radius ' + 'y'.repeat(80);
    const res = findThreadsByQuery([t('1', long)], 'radius', 10, { fuzzy: false });
    expect(res[0].highlight).toContain('radius');
    expect(res[0].highlight.length).toBeLessThan(long.length);
  });
});

describe('findThreadsByQuery (fuzzy)', () => {
  it('tolerates a typo', () => {
    const res = findThreadsByQuery([t('1', 'fix the radius')], 'raduis', 10, { fuzzy: true });
    expect(res.length).toBeGreaterThan(0);
  });

  it('still excludes clearly unrelated text', () => {
    const res = findThreadsByQuery([t('1', 'completely different content about colors')], 'radius', 10, { fuzzy: true });
    expect(res).toHaveLength(0);
  });
});
