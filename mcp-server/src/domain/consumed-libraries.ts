import type { FigmaApi } from '../ports/figma-api.js';
import type { ComponentRefMeta } from './figma-raw.js';
import { FigmaApiError } from '../ports/errors.js';

export interface ConsumedLibrary {
  file_key: string;
  component_count: number;
  sample: string[];
}

export interface ConsumedLibrariesResult {
  libraries: ConsumedLibrary[];
  // true when at least one remote component key could not be resolved (so the count may undercount).
  degraded?: boolean;
}

/**
 * Detect the external design-system libraries a Figma file actually consumes.
 *
 * The Figma REST API has no "subscribed libraries" endpoint, but `GET /v1/files/:key`
 * (and `/nodes`) returns a top-level `components`/`componentSets` map whose entries are
 * flagged `remote: true` when the component comes from another library. Resolving each
 * remote key via `GET /v1/components/:key` yields its source `file_key`, letting us group
 * consumed components by the library that defines them.
 *
 * Best-effort: surfaces libraries the file USES, not merely-subscribed-but-unused ones.
 * Per-key resolution errors are swallowed (and flip `degraded`); only rate limiting rethrows.
 */
export async function resolveConsumedLibraries(
  api: FigmaApi,
  fileKey: string,
  opts: { nodeId?: string; depth?: number } = {},
): Promise<ConsumedLibrariesResult> {
  const depth = opts.depth ?? 4;

  // 1. Fetch the component map — whole file, or scoped to one node's subtree.
  let components: Record<string, ComponentRefMeta> = {};
  let componentSets: Record<string, ComponentRefMeta> = {};
  if (opts.nodeId) {
    const res = await api.getNodesRaw(fileKey, [opts.nodeId], depth);
    components = res.nodes[opts.nodeId]?.components ?? {};
  } else {
    const doc = await api.getDocumentRaw(fileKey, depth);
    components = doc.components ?? {};
    componentSets = doc.componentSets ?? {};
  }

  // 2. Collect the unique published keys of components consumed from elsewhere.
  const remoteKeys = new Set<string>();
  for (const ref of [...Object.values(components), ...Object.values(componentSets)]) {
    if (ref?.remote && ref.key) remoteKeys.add(ref.key);
  }
  if (remoteKeys.size === 0) return { libraries: [] };

  // 3. Resolve each key to its source library and group.
  let degraded = false;
  const byLib = new Map<string, ConsumedLibrary>();
  await Promise.all([...remoteKeys].map(async (key) => {
    try {
      const c = await api.getComponent(key);
      if (c.file_key === fileKey) return; // resolves back to this file → not external
      let lib = byLib.get(c.file_key);
      if (!lib) { lib = { file_key: c.file_key, component_count: 0, sample: [] }; byLib.set(c.file_key, lib); }
      lib.component_count++;
      if (lib.sample.length < 8 && c.name) lib.sample.push(c.name);
    } catch (e) {
      // Surface rate limiting so the agent backs off; a missing/deleted component just drops out.
      if (e instanceof FigmaApiError && e.kind === 'rate_limited') throw e;
      degraded = true;
    }
  }));

  const libraries = [...byLib.values()].sort((a, b) => b.component_count - a.component_count);
  return degraded ? { libraries, degraded } : { libraries };
}
