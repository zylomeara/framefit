import type { Thread, SummarizeOutput } from './types.js';
import { isoWeek } from './iso-week.js';
import { renderAnchorLabel } from './anchor-label.js';

export function summarizeThreads(threads: Thread[], opts: { top_n: number }): SummarizeOutput {
  const byAuthor = new Map<string, { handle: string; total: number; open: number; resolved: number }>();
  const byAnchor = { canvas_point: 0, canvas_region: 0, node: 0, node_region: 0 };
  const byNode = new Map<string, { node_name: string; page_name: string; count: number }>();
  const byWeek = new Map<string, number>();
  let open = 0;
  let resolved = 0;
  let withMentions = 0;

  for (const t of threads) {
    if (t.resolved) resolved++;
    else open++;

    const a = byAuthor.get(t.root.author.id) ?? { handle: t.root.author.handle, total: 0, open: 0, resolved: 0 };
    a.total++;
    if (t.resolved) a.resolved++;
    else a.open++;
    byAuthor.set(t.root.author.id, a);

    byAnchor[t.anchor.kind]++;

    if (t.anchor.kind === 'node' || t.anchor.kind === 'node_region') {
      const k = t.anchor.node_id;
      const entry = byNode.get(k) ?? { node_name: t.anchor.node_name, page_name: t.anchor.page_name, count: 0 };
      entry.count++;
      byNode.set(k, entry);
    }

    const week = isoWeek(new Date(t.root.created_at));
    byWeek.set(week, (byWeek.get(week) ?? 0) + 1);

    const anyMentions = t.root.mentions.length > 0 || t.replies.some((r) => r.mentions.length > 0);
    if (anyMentions) withMentions++;
  }

  return {
    total: threads.length,
    open,
    resolved,
    by_author: [...byAuthor.entries()]
      .map(([id, v]) => ({ author_id: id, author_handle: v.handle, total: v.total, open: v.open, resolved: v.resolved }))
      .sort((x, y) => y.total - x.total),
    by_anchor: byAnchor,
    by_top_nodes: [...byNode.entries()]
      .map(([node_id, v]) => ({ node_id, node_name: v.node_name, page_name: v.page_name, count: v.count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, opts.top_n),
    top_threads_by_replies: [...threads]
      .filter((t) => t.replies.length > 0)
      .sort((x, y) => y.replies.length - x.replies.length)
      .slice(0, opts.top_n)
      .map((t) => ({
        thread_id: t.id,
        root_author: t.root.author.handle,
        root_excerpt: t.root.message.slice(0, 200),
        replies_count: t.replies.length,
        anchor_label: renderAnchorLabel(t.anchor),
      })),
    by_date: [...byWeek.entries()]
      .map(([week, count]) => ({ week, count }))
      .sort((x, y) => x.week.localeCompare(y.week)),
    with_mentions: withMentions,
  };
}
