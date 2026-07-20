import type { FigmaApi } from '../ports/figma-api.js';
import type { Thread, NodeRefMap } from '../domain/types.js';
import type { FileStructure } from '../domain/file-structure.js';
import { findPageName } from '../domain/file-structure.js';

export type AnchorResolveOpts = {
  include_descendants: boolean;
  node_type?: string;
  node_depth: number;
};

export async function resolveAnchors(
  api: FigmaApi,
  fileKey: string,
  threads: Thread[],
  opts: AnchorResolveOpts,
): Promise<{ threads: Thread[]; structure: FileStructure | null }> {
  const nodeIds = uniqueNodeIds(threads);
  const needsStructure = nodeIds.length > 0 || opts.include_descendants || Boolean(opts.node_type);
  if (!needsStructure) return { threads, structure: null };

  const structure = await api.getFileStructure(fileKey);

  const nodes: NodeRefMap = new Map();
  for (const id of nodeIds) {
    const n = structure.nodeById.get(id);
    if (n) nodes.set(id, { name: n.name, page_name: findPageName(structure, id) });
  }

  const missing = nodeIds.filter((id) => !nodes.has(id));
  if (missing.length) {
    const extra = await api.resolveNodes(fileKey, missing, { depth: opts.node_depth });
    for (const [id, ref] of extra) nodes.set(id, ref);
  }

  const enriched = threads.map((t) => {
    const a = t.anchor;
    if (a.kind === 'node' || a.kind === 'node_region') {
      const ref = nodes.get(a.node_id);
      if (ref) return { ...t, anchor: { ...a, node_name: ref.name, page_name: ref.page_name } };
    }
    return t;
  });

  return { threads: enriched, structure };
}

function uniqueNodeIds(threads: Thread[]): string[] {
  const set = new Set<string>();
  for (const t of threads) {
    const a = t.anchor;
    if (a.kind === 'node' || a.kind === 'node_region') set.add(a.node_id);
  }
  return [...set];
}
