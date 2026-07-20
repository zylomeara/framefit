import { describe, it, expect } from 'vitest';
import { groupThreads } from '../../src/domain/group-threads.js';
import fixture from '../fixtures/comments-sample.json';
import type { RawComment } from '../../src/domain/types.js';

const raw = fixture.comments as unknown as RawComment[];

describe('groupThreads', () => {
  it('returns one thread per root comment', () => {
    const ids = groupThreads(raw).map((t) => t.id).sort();
    expect(ids).toEqual(['1001', '2001', '3001', '4001']);
  });

  it('attaches replies under their root', () => {
    const t = groupThreads(raw).find((x) => x.id === '1001')!;
    expect(t.replies.map((r) => r.id)).toEqual(['1002']);
  });

  it('sets kind=thread when replies exist, single otherwise', () => {
    const threads = groupThreads(raw);
    expect(threads.find((x) => x.id === '1001')!.kind).toBe('thread');
    expect(threads.find((x) => x.id === '2001')!.kind).toBe('single');
  });

  it('sorts replies by created_at ascending', () => {
    const reordered = [
      raw[0],
      { ...raw[1], id: '1003', created_at: '2026-05-15T13:00:00Z' },
      { ...raw[1], id: '1002', created_at: '2026-05-15T12:01:00Z' },
    ];
    const t = groupThreads(reordered as RawComment[]).find((x) => x.id === '1001')!;
    expect(t.replies.map((r) => r.id)).toEqual(['1002', '1003']);
  });

  it('keeps orphan reply as its own thread', () => {
    const orphan: RawComment = { ...(raw[1] as RawComment), id: '9999', parent_id: 'nonexistent' };
    const t = groupThreads([...(raw as RawComment[]), orphan]).find((x) => x.id === '9999');
    expect(t).toBeDefined();
    expect(t!.replies).toEqual([]);
  });

  it('decodes all 4 client_meta forms', () => {
    const kinds = groupThreads(raw).map((t) => t.anchor.kind).sort();
    expect(kinds).toEqual(['canvas_point', 'canvas_region', 'node', 'node_region']);
  });

  it('builds author object, mentions, and reactions_count', () => {
    const threads = groupThreads(raw);
    const t1001 = threads.find((x) => x.id === '1001')!;
    expect(t1001.root.author).toEqual({ id: 'u-anna', handle: 'Анна' });
    expect(t1001.root.reactions_count).toBe(1);

    const t3001 = threads.find((x) => x.id === '3001')!;
    expect(t3001.root.mentions).toEqual(['anna']);
  });
});
