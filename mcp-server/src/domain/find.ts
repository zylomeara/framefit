import Fuse from 'fuse.js';
import type { Thread, MatchedThread } from './types.js';
import { renderAnchorLabel } from './anchor-label.js';

type FindOpts = { fuzzy: boolean };

export function findThreadsByQuery(
  threads: Thread[],
  query: string,
  limit: number,
  opts: FindOpts,
): MatchedThread[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  return opts.fuzzy
    ? fuzzyFind(threads, query, terms, limit)
    : substringFind(threads, terms, limit);
}

function substringFind(threads: Thread[], terms: string[], limit: number): MatchedThread[] {
  const matches: MatchedThread[] = [];

  for (const t of threads) {
    let bestScore = scoreMessage(t.root.message, terms);
    let matchedIn: 'root' | 'reply' = 'root';
    let matchedMessage = t.root.message;

    for (const r of t.replies) {
      const s = scoreMessage(r.message, terms);
      if (s > bestScore) {
        bestScore = s;
        matchedIn = 'reply';
        matchedMessage = r.message;
      }
    }

    if (bestScore <= 0) continue;
    const finalScore = Math.min(1, bestScore + (matchedIn === 'root' ? 0.2 : 0));
    matches.push(toMatched(t, finalScore, matchedIn, makeHighlight(matchedMessage, terms)));
  }

  return matches
    .sort((a, b) => b.score - a.score || b.thread_id.localeCompare(a.thread_id))
    .slice(0, limit);
}

function fuzzyFind(threads: Thread[], query: string, terms: string[], limit: number): MatchedThread[] {
  type Row = { thread: Thread; role: 'root' | 'reply'; message: string };
  const rows: Row[] = [];
  for (const t of threads) {
    rows.push({ thread: t, role: 'root', message: t.root.message });
    for (const r of t.replies) rows.push({ thread: t, role: 'reply', message: r.message });
  }

  const fuse = new Fuse(rows, { keys: ['message'], includeScore: true, threshold: 0.4, ignoreLocation: true });
  const results = fuse.search(query);

  const bestByThread = new Map<string, { row: Row; fuseScore: number }>();
  for (const r of results) {
    const id = r.item.thread.id;
    const fuseScore = r.score ?? 1;
    const cur = bestByThread.get(id);
    if (!cur || fuseScore < cur.fuseScore) bestByThread.set(id, { row: r.item, fuseScore });
  }

  return [...bestByThread.values()]
    .map(({ row, fuseScore }) => {
      const score = Math.max(0, Math.min(1, 1 - fuseScore));
      return toMatched(row.thread, score, row.role, makeHighlight(row.message, terms));
    })
    .sort((a, b) => b.score - a.score || b.thread_id.localeCompare(a.thread_id))
    .slice(0, limit);
}

function scoreMessage(message: string, terms: string[]): number {
  const lower = message.toLowerCase();
  const matched = terms.filter((t) => lower.includes(t));
  if (matched.length === 0) return 0;
  let score = matched.length / terms.length;
  if (matched.length === terms.length) score = Math.min(1, score + 0.1);
  return score;
}

function makeHighlight(message: string, terms: string[]): string {
  const lower = message.toLowerCase();
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0) {
      const start = Math.max(0, i - 50);
      const end = Math.min(message.length, i + term.length + 50);
      return (start > 0 ? '…' : '') + message.slice(start, end) + (end < message.length ? '…' : '');
    }
  }
  return message.slice(0, 100);
}

function toMatched(t: Thread, score: number, matchedIn: 'root' | 'reply', highlight: string): MatchedThread {
  return {
    thread_id: t.id,
    score,
    matched_in: matchedIn,
    anchor_label: renderAnchorLabel(t.anchor),
    root_author: t.root.author.handle,
    root_excerpt: t.root.message.slice(0, 200),
    highlight,
  };
}
