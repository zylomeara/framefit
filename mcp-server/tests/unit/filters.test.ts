import { describe, it, expect } from 'vitest';
import { applyFilters } from '../../src/domain/filters.js';
import { buildFileStructure } from '../../src/domain/file-structure.js';
import type { Thread, FilterCriteria, CommentInThread } from '../../src/domain/types.js';
import type { RawDocumentNode } from '../../src/domain/file-structure.js';
import structFixture from '../fixtures/file-structure-sample.json';

const structure = buildFileStructure(structFixture.document as unknown as RawDocumentNode);

function comment(over: Partial<CommentInThread> = {}): CommentInThread {
  return {
    id: 'c1',
    author: { id: 'u1', handle: 'Anna' },
    created_at: '2026-05-15T10:00:00Z',
    message: 'hello',
    mentions: [],
    reactions_count: 0,
    ...over,
  };
}

function thread(over: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    kind: 'single',
    resolved: false,
    anchor: { kind: 'canvas_point', x: 0, y: 0 },
    root: comment(),
    replies: [],
    ...over,
  };
}

const base: FilterCriteria = { include_resolved: true, include_descendants: false };

describe('applyFilters', () => {
  it('include_resolved=false drops resolved threads', () => {
    const threads = [thread({ id: 'open' }), thread({ id: 'done', resolved: true })];
    expect(applyFilters(threads, { ...base, include_resolved: false }, null).map((t) => t.id)).toEqual(['open']);
  });

  it('node_id exact match (no descendants)', () => {
    const threads = [
      thread({ id: 'on42', anchor: { kind: 'node', node_id: '1:42', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
      thread({ id: 'on55', anchor: { kind: 'node', node_id: '1:55', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
    ];
    expect(applyFilters(threads, { ...base, node_id: '1:42' }, structure).map((t) => t.id)).toEqual(['on42']);
  });

  it('node_id + include_descendants includes child nodes', () => {
    const threads = [
      thread({ id: 'header', anchor: { kind: 'node', node_id: '1:55', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
      thread({ id: 'logo', anchor: { kind: 'node', node_id: '1:56', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
      thread({ id: 'button', anchor: { kind: 'node', node_id: '1:42', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
    ];
    expect(applyFilters(threads, { ...base, node_id: '1:55', include_descendants: true }, structure).map((t) => t.id).sort()).toEqual(['header', 'logo']);
  });

  it('node_type filters by structure node type', () => {
    const threads = [
      thread({ id: 'comp', anchor: { kind: 'node', node_id: '1:42', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
      thread({ id: 'frame', anchor: { kind: 'node', node_id: '1:55', node_name: '', page_name: '', offset: { x: 0, y: 0 } } }),
    ];
    expect(applyFilters(threads, { ...base, node_type: 'COMPONENT' }, structure).map((t) => t.id)).toEqual(['comp']);
  });

  it('author_id takes priority over author_handle', () => {
    const threads = [
      thread({ id: 'a', root: comment({ author: { id: 'u-anna', handle: 'Anna' } }) }),
      thread({ id: 'b', root: comment({ author: { id: 'u-petya', handle: 'Petya' } }) }),
    ];
    expect(applyFilters(threads, { ...base, author_id: 'u-petya', author_handle: 'Anna' }, null).map((t) => t.id)).toEqual(['b']);
  });

  it('message_contains matches in a reply too', () => {
    const threads = [
      thread({ id: 'hit', kind: 'thread', replies: [comment({ message: 'please fix the RADIUS now' })] }),
      thread({ id: 'miss' }),
    ];
    expect(applyFilters(threads, { ...base, message_contains: 'radius' }, null).map((t) => t.id)).toEqual(['hit']);
  });

  it('since/until bound by root created_at (inclusive)', () => {
    const threads = [
      thread({ id: 'early', root: comment({ created_at: '2026-05-01T00:00:00Z' }) }),
      thread({ id: 'mid', root: comment({ created_at: '2026-05-15T00:00:00Z' }) }),
      thread({ id: 'late', root: comment({ created_at: '2026-05-30T00:00:00Z' }) }),
    ];
    expect(applyFilters(threads, { ...base, since: '2026-05-10T00:00:00Z', until: '2026-05-20T00:00:00Z' }, null).map((t) => t.id)).toEqual(['mid']);
  });

  it('min_replies=0 keeps all; min_replies=1 drops singles', () => {
    const threads = [thread({ id: 'single' }), thread({ id: 'thread', kind: 'thread', replies: [comment()] })];
    expect(applyFilters(threads, { ...base, min_replies: 0 }, null).length).toBe(2);
    expect(applyFilters(threads, { ...base, min_replies: 1 }, null).map((t) => t.id)).toEqual(['thread']);
  });

  it('min_reactions filters on root', () => {
    const threads = [
      thread({ id: 'reacted', root: comment({ reactions_count: 3 }) }),
      thread({ id: 'none', root: comment({ reactions_count: 0 }) }),
    ];
    expect(applyFilters(threads, { ...base, min_reactions: 1 }, null).map((t) => t.id)).toEqual(['reacted']);
  });

  it('has_mentions matches root or reply', () => {
    const threads = [
      thread({ id: 'root-m', root: comment({ mentions: ['anna'] }) }),
      thread({ id: 'reply-m', kind: 'thread', replies: [comment({ mentions: ['petya'] })] }),
      thread({ id: 'none' }),
    ];
    expect(applyFilters(threads, { ...base, has_mentions: true }, null).map((t) => t.id).sort()).toEqual(['reply-m', 'root-m']);
  });

  it('combines filters with AND', () => {
    const threads = [
      thread({ id: 'match', root: comment({ author: { id: 'u-anna', handle: 'Anna' }, message: 'radius' }) }),
      thread({ id: 'wrong-author', root: comment({ author: { id: 'u-x', handle: 'X' }, message: 'radius' }) }),
      thread({ id: 'wrong-msg', root: comment({ author: { id: 'u-anna', handle: 'Anna' }, message: 'other' }) }),
    ];
    expect(applyFilters(threads, { ...base, author_id: 'u-anna', message_contains: 'radius' }, null).map((t) => t.id)).toEqual(['match']);
  });
});
