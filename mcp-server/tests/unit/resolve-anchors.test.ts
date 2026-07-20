import { describe, it, expect } from 'vitest';
import { resolveAnchors } from '../../src/application/resolve-anchors.js';
import { buildFileStructure } from '../../src/domain/file-structure.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { Thread, NodeRefMap, CommentInThread } from '../../src/domain/types.js';
import type { FileStructure, RawDocumentNode } from '../../src/domain/file-structure.js';
import type { RawComment } from '../../src/domain/types.js';
import structFixture from '../fixtures/file-structure-sample.json';

const structure = buildFileStructure(structFixture.document as unknown as RawDocumentNode);

function comment(): CommentInThread {
  return { id: 'c', author: { id: 'u', handle: 'A' }, created_at: '2026-05-15T00:00:00Z', message: 'm', mentions: [], reactions_count: 0 };
}
function nodeThread(id: string, nodeId: string): Thread {
  return { id, kind: 'single', resolved: false, anchor: { kind: 'node', node_id: nodeId, node_name: '', page_name: '', offset: { x: 0, y: 0 } }, root: comment(), replies: [] };
}
function canvasThread(id: string): Thread {
  return { id, kind: 'single', resolved: false, anchor: { kind: 'canvas_point', x: 0, y: 0 }, root: comment(), replies: [] };
}

class FakeApi {
  fileStructureCalls = 0;
  resolveNodesCalls = 0;
  constructor(private resolveResp: NodeRefMap = new Map()) {}
  async getComments(): Promise<RawComment[]> { return []; }
  async resolveNodes(_k: string, ids: string[]): Promise<NodeRefMap> {
    this.resolveNodesCalls++;
    if (!ids.length) return new Map();
    return this.resolveResp;
  }
  async getFileStructure(): Promise<FileStructure> { this.fileStructureCalls++; return structure; }
  async getDocumentRaw(): Promise<any> { return {}; }
  async getNodesRaw(): Promise<any> { return { nodes: {} }; }
  async getImages(): Promise<any> { return { images: {} }; }
  async getVariablesLocal(): Promise<any> { return {}; }
  async getFileVersion(): Promise<any> { return { version: '1', name: 'F', lastModified: 'X' }; }
  async getTeamLibrary(): Promise<any> { return { components: [], componentSets: [], styles: [] }; }
  async getTeamProjects(): Promise<any> { return []; }
  async getProjectFiles(): Promise<any> { return []; }
  async getFileComponents(): Promise<any> { return []; }
}

const noFilter = { include_descendants: false, node_type: undefined, node_depth: 0 };

describe('resolveAnchors', () => {
  it('skips structure when no node anchors and no structural filter', async () => {
    const api = new FakeApi();
    const res = await resolveAnchors(api as unknown as FigmaApi, 'key', [canvasThread('a')], noFilter);
    expect(api.fileStructureCalls).toBe(0);
    expect(res.structure).toBeNull();
  });

  it('loads structure and enriches node anchors with name + page', async () => {
    const api = new FakeApi();
    const res = await resolveAnchors(api as unknown as FigmaApi, 'key', [nodeThread('t', '1:42')], noFilter);
    expect(api.fileStructureCalls).toBe(1);
    const a = res.threads[0].anchor;
    expect(a.kind).toBe('node');
    if (a.kind === 'node') {
      expect(a.node_name).toBe('Button / Primary');
      expect(a.page_name).toBe('Components');
    }
  });

  it('loads structure when include_descendants even without node anchors', async () => {
    const api = new FakeApi();
    const res = await resolveAnchors(api as unknown as FigmaApi, 'key', [canvasThread('a')], { ...noFilter, include_descendants: true });
    expect(api.fileStructureCalls).toBe(1);
    expect(res.structure).not.toBeNull();
  });

  it('falls back to resolveNodes for a node missing from structure', async () => {
    const api = new FakeApi(new Map([['9:99', { name: 'Deep', page_name: '' }]]));
    const res = await resolveAnchors(api as unknown as FigmaApi, 'key', [nodeThread('t', '9:99')], noFilter);
    expect(api.resolveNodesCalls).toBe(1);
    const a = res.threads[0].anchor;
    if (a.kind === 'node') expect(a.node_name).toBe('Deep');
  });
});
