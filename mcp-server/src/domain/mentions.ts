const MENTION_RE = /@([a-zA-Z0-9._-]+)/g;

export function extractMentions(message: string): string[] {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset lastIndex defensively (global regex is stateful).
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(message)) !== null) set.add(m[1]);
  return [...set];
}
