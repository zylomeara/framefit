export type FileNode = { id: string; name: string; type: string };

// Raw node shape from GET /v1/files/:key document tree.
export type RawDocumentNode = {
  id: string;
  name: string;
  type: string;
  children?: RawDocumentNode[];
};

export type FileStructure = {
  nodeById: Map<string, FileNode>;
  pageNameByNodeId: Map<string, string>;
  childrenByNodeId: Map<string, string[]>;
};

export function buildFileStructure(document: RawDocumentNode): FileStructure {
  const nodeById = new Map<string, FileNode>();
  const pageNameByNodeId = new Map<string, string>();
  const childrenByNodeId = new Map<string, string[]>();

  function walk(node: RawDocumentNode, currentPage: string | null): void {
    nodeById.set(node.id, { id: node.id, name: node.name, type: node.type });
    if (currentPage !== null) pageNameByNodeId.set(node.id, currentPage);

    const children = node.children ?? [];
    if (children.length) childrenByNodeId.set(node.id, children.map((c) => c.id));

    const pageForChildren = node.type === 'CANVAS' ? node.name : currentPage;
    for (const c of children) walk(c, pageForChildren);
  }

  walk(document, null);
  return { nodeById, pageNameByNodeId, childrenByNodeId };
}

export function findPageName(structure: FileStructure, nodeId: string): string {
  return structure.pageNameByNodeId.get(nodeId) ?? '';
}

export function collectDescendants(structure: FileStructure, nodeId: string): Set<string> {
  const out = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    const kids = structure.childrenByNodeId.get(id);
    if (!kids) continue;
    for (const k of kids) {
      if (!out.has(k)) {
        out.add(k);
        stack.push(k);
      }
    }
  }
  return out;
}
