// mcp-server/src/domain/code-connect.ts
// Code Connect mapping shapes + normalization. Mappings come from `figma connect
// parse` (CodeConnectJSON[]); we store the (file_key, node_id) of the library
// component, the rendered template/props, and provenance, to enrich design context.
import { normalizeNodeId } from './node-id.js';

export interface CodeConnectJSON {
  figmaNode: string;
  label?: string;
  language?: string;
  component?: string;
  source?: string;
  template?: string;
  templateData?: { props?: Record<string, unknown>; imports?: string[]; nestable?: boolean };
}

export interface StoredMapping {
  component_file_key: string;
  component_node_id: string; // normalized "1:5"
  label: string;
  component_name: string;
  source: string;
  template: string;
  template_data: { props?: Record<string, unknown>; imports?: string[]; nestable?: boolean };
}

// A mapping resolved from the store for one (file_key,node_id). Lives in domain
// so both the multi-tenant adapter (returns it) and domain/enrich (consumes it)
// depend on domain, never the reverse.
export interface MappingHit {
  component_name: string;
  source: string;
  template: string;
  template_data: { props?: Record<string, unknown>; imports?: string[]; nestable?: boolean };
  label: string;
}

const URL_KEY_RE = /figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/;

/**
 * Extract (file_key, node_id) from a `figmaNode` URL emitted by `figma connect parse`.
 * Expects a simple `page-node` node id (library components only) — normalizeNodeId
 * replaces only the first '-', so compound instance ids are out of scope here.
 * Returns null if the URL has no recognizable file key or node-id.
 */
export function parseFigmaNodeUrl(figmaNode: string): { file_key: string; node_id: string } | null {
  if (typeof figmaNode !== 'string') return null;
  const keyMatch = figmaNode.match(URL_KEY_RE);
  if (!keyMatch) return null;
  let nodeRaw: string | null = null;
  try {
    nodeRaw = new URL(figmaNode).searchParams.get('node-id');
  } catch {
    const m = figmaNode.match(/[?&]node-id=([^&]+)/);
    nodeRaw = m ? decodeURIComponent(m[1]) : null;
  }
  if (!nodeRaw) return null;
  return { file_key: keyMatch[1], node_id: normalizeNodeId(nodeRaw) };
}

export function normalizeDocs(docs: CodeConnectJSON[]): StoredMapping[] {
  const out: StoredMapping[] = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    const ref = parseFigmaNodeUrl((d as CodeConnectJSON).figmaNode);
    if (!ref) continue;
    out.push({
      component_file_key: ref.file_key,
      component_node_id: ref.node_id,
      label: d.label ?? 'React',
      component_name: d.component ?? '',
      source: d.source ?? '',
      template: d.template ?? '',
      template_data: d.templateData ?? {},
    });
  }
  return out;
}
