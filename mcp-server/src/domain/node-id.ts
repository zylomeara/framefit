// Figma node ids are "<page>:<node>" in REST/client_meta, "<page>-<node>" in URLs.
export const NODE_ID_RE = /^\d+[:\-]\d+$/;

export function normalizeNodeId(id: string): string {
  return id.replace('-', ':');
}

// A nested-instance id is a ';'-joined chain of plain ids, optionally prefixed 'I'
// (Figma's instance-path form), e.g. "I12:340;56:7890". Also accepts a plain id.
export const COMPOUND_NODE_ID_RE = /^I?\d+[:\-]\d+(?:;\d+[:\-]\d+)*$/;

// Normalize URL dashes to REST colons across every segment, preserving a leading 'I'.
// Each segment has at most one dash, so a per-segment single replace is correct.
export function normalizeCompoundNodeId(id: string): string {
  const hasI = id.startsWith('I');
  const core = hasI ? id.slice(1) : id;
  const norm = core.split(';').map((seg) => seg.replace('-', ':')).join(';');
  return hasI ? `I${norm}` : norm;
}

/**
 * Validate a root already selected from a scoped /nodes response entry and return a fresh root
 * object carrying the requested id. Besides full I/no-I equality, Figma may return only a compound
 * request's exact terminal id at this boundary. That compatibility does not apply to
 * documentary-tree matching. The copy is shallow: descendants stay shared with the (possibly
 * cached) response, so a caller that rewrites descendants must copy them itself.
 */
export function normalizeScopedResponseRoot<T extends object>(
  root: T | null | undefined,
  requestedId: string,
): T | undefined {
  const rawId = (root as { id?: unknown } | null)?.id;
  if (typeof rawId !== 'string') return undefined;
  const requested = normalizeCompoundNodeId(requestedId);
  const returned = normalizeCompoundNodeId(rawId);
  const requestedCore = requested.startsWith('I') ? requested.slice(1) : requested;
  const returnedCore = returned.startsWith('I') ? returned.slice(1) : returned;
  const fullMatch = requestedCore === returnedCore;
  const terminalMatch = COMPOUND_NODE_ID_RE.test(requested)
    && COMPOUND_NODE_ID_RE.test(returned)
    && requestedCore.includes(';')
    && !returned.startsWith('I')
    && !returnedCore.includes(';')
    && returnedCore === requestedCore.slice(requestedCore.lastIndexOf(';') + 1);
  if (!fullMatch && !terminalMatch) return undefined;
  return { ...root, id: requested } as T;
}
