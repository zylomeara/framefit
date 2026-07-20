import type { Thread, CommentInThread } from './types.js';
import { renderAnchorLabel } from './anchor-label.js';

export function formatMarkdown(threads: Thread[]): string {
  return threads.map(renderThread).join('\n\n---\n\n');
}

function renderThread(t: Thread): string {
  const status = t.resolved ? 'resolved' : 'open';
  const header = `## Thread #${t.id} (${status}) · ${renderAnchorLabel(t.anchor)}`;
  const root = renderComment(t.root);
  const replies = t.replies.map((r) => '  ↳ ' + renderComment(r)).join('\n');
  return [header, root, replies].filter(Boolean).join('\n\n');
}

function renderComment(c: CommentInThread): string {
  const lines = c.message.split('\n').map((l) => `> ${l}`).join('\n');
  return `**${c.author.handle}** · ${c.created_at}\n${lines}`;
}
