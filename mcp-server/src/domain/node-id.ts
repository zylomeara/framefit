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
