import { FigmaApiError } from '../ports/errors.js';
import type { RawSceneNode } from '../domain/figma-raw.js';
import type { FigmaApi } from '../ports/figma-api.js';

const MAX_CONTAINERS = 5;
const MAX_CANDIDATES = 5;

export interface ComponentInstanceCandidate {
  node_id: string;
  name: string;
  path: string[];
}

export interface FindComponentInstancesResult {
  candidates: ComponentInstanceCandidate[];
  partial?: true;
}

export interface FindComponentInstancesOptions {
  deadlineAt?: number;
  now?: () => number;
}

const isHardFailure = (error: unknown): boolean =>
  error instanceof FigmaApiError
  && (error.kind === 'auth' || error.kind === 'forbidden' || error.kind === 'rate_limited');

/**
 * Bounded whole-file instance discovery for an empty component definition. A depth-2 document
 * skeleton identifies top-level containers, then no more than five depth-8 chunks are walked in
 * document order. It is deliberately best-effort: a non-auth chunk failure keeps candidates
 * already found so get_design_context can still return its core response.
 */
export async function findComponentInstances(
  api: Pick<FigmaApi, 'getDocumentRaw' | 'getNodesRaw'>,
  fileKey: string,
  componentId: string,
  opts: FindComponentInstancesOptions = {},
): Promise<FindComponentInstancesResult> {
  const now = opts.now ?? Date.now;
  const expired = (): boolean => opts.deadlineAt !== undefined && now() >= opts.deadlineAt;
  if (expired()) return { candidates: [], partial: true };

  let skeleton: Awaited<ReturnType<FigmaApi['getDocumentRaw']>>;
  try {
    skeleton = await api.getDocumentRaw(fileKey, 2);
  } catch (error) {
    if (isHardFailure(error)) throw error;
    return { candidates: [], partial: true };
  }

  const containers = (skeleton.document.children ?? []).flatMap((page) =>
    (page.children ?? []).map((node) => ({ page: page.name, node })));
  const candidates: ComponentInstanceCandidate[] = [];
  let partial = false;

  const collect = (node: RawSceneNode, path: string[]): void => {
    if (node.visible === false || candidates.length >= MAX_CANDIDATES) return;
    if (node.type === 'INSTANCE' && node.componentId === componentId) {
      candidates.push({ node_id: node.id, name: node.name, path });
    }
    for (const child of node.children ?? []) collect(child, [...path, node.name]);
  };

  for (const { page, node } of containers.slice(0, MAX_CONTAINERS)) {
    if (candidates.length >= MAX_CANDIDATES) break;
    if (expired()) { partial = true; break; }
    try {
      const chunk = await api.getNodesRaw(fileKey, [node.id], 8);
      const document = chunk.nodes[node.id]?.document;
      if (!document) { partial = true; continue; }
      collect(document, [page]);
    } catch (error) {
      if (isHardFailure(error)) throw error;
      partial = true;
    }
  }

  return { candidates, ...(partial ? { partial: true as const } : {}) };
}
