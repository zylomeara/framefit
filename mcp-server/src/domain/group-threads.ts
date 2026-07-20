import type { RawComment, Thread, ThreadAnchor, CommentInThread, ClientMeta } from './types.js';
import { extractMentions } from './mentions.js';

export function groupThreads(comments: RawComment[]): Thread[] {
  const byId = new Map<string, RawComment>();
  for (const c of comments) byId.set(c.id, c);

  const roots: RawComment[] = [];
  const repliesByParent = new Map<string, RawComment[]>();

  for (const c of comments) {
    const parentId = c.parent_id;
    const isRoot = !parentId || !byId.has(parentId);
    if (isRoot) {
      roots.push(c);
    } else {
      const list = repliesByParent.get(parentId) ?? [];
      list.push(c);
      repliesByParent.set(parentId, list);
    }
  }

  const threads: Thread[] = [];
  for (const root of roots) {
    const replies = (repliesByParent.get(root.id) ?? [])
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(toComment);

    threads.push({
      id: root.id,
      kind: replies.length > 0 ? 'thread' : 'single',
      resolved: Boolean(root.resolved_at),
      anchor: decodeAnchor(root.client_meta),
      root: toComment(root),
      replies,
    });
  }

  return threads;
}

function toComment(c: RawComment): CommentInThread {
  return {
    id: c.id,
    author: { id: c.user.id, handle: c.user.handle },
    created_at: c.created_at,
    message: c.message,
    mentions: extractMentions(c.message),
    reactions_count: c.reactions?.length ?? 0,
  };
}

function decodeAnchor(meta: ClientMeta | Record<string, unknown>): ThreadAnchor {
  const m = meta as Record<string, unknown>;
  const hasNode = typeof m.node_id === 'string';
  const hasRegion =
    typeof m.region_height === 'number' && typeof m.region_width === 'number';

  if (hasNode && hasRegion) {
    return {
      kind: 'node_region',
      node_id: m.node_id as string,
      node_name: '',
      page_name: '',
      offset: readOffset(m.region_offset),
      width: m.region_width as number,
      height: m.region_height as number,
    };
  }
  if (hasNode) {
    return {
      kind: 'node',
      node_id: m.node_id as string,
      node_name: '',
      page_name: '',
      offset: readOffset(m.node_offset),
    };
  }
  if (hasRegion) {
    return {
      kind: 'canvas_region',
      x: (m.x as number) ?? 0,
      y: (m.y as number) ?? 0,
      width: m.region_width as number,
      height: m.region_height as number,
    };
  }
  return { kind: 'canvas_point', x: (m.x as number) ?? 0, y: (m.y as number) ?? 0 };
}

function readOffset(raw: unknown): { x: number; y: number } {
  if (raw && typeof raw === 'object') {
    const r = raw as { x?: unknown; y?: unknown };
    return { x: typeof r.x === 'number' ? r.x : 0, y: typeof r.y === 'number' ? r.y : 0 };
  }
  return { x: 0, y: 0 };
}
