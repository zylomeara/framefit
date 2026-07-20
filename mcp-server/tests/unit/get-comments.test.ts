import { describe, it, expect } from 'vitest';
import { getCommentsUseCase } from '../../src/application/get-comments.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { RawComment, NodeRefMap, FilterCriteria } from '../../src/domain/types.js';
import type { FileStructure, RawDocumentNode } from '../../src/domain/file-structure.js';
import { buildFileStructure } from '../../src/domain/file-structure.js';
import fixture from '../fixtures/comments-sample.json';
import structFixture from '../fixtures/file-structure-sample.json';
import { createLogger } from '../../src/infrastructure/logger.js';

const silent = createLogger({ level: 'silent' });
const rawComments = fixture.comments as unknown as RawComment[];
const structure = buildFileStructure(structFixture.document as unknown as RawDocumentNode);

class FakeFigmaApi {
  resolveNodesCalls = 0;
  fileStructureCalls = 0;
  constructor(
    private commentsResp: RawComment[] | Error = rawComments,
    private nodesResp: NodeRefMap | Error = new Map(),
  ) {}
  async getComments(): Promise<RawComment[]> {
    if (this.commentsResp instanceof Error) throw this.commentsResp;
    return this.commentsResp;
  }
  async resolveNodes(_k: string, ids: string[]): Promise<NodeRefMap> {
    this.resolveNodesCalls++;
    if (this.nodesResp instanceof Error) throw this.nodesResp;
    if (!ids.length) return new Map();
    return this.nodesResp;
  }
  async getFileStructure(): Promise<FileStructure> {
    this.fileStructureCalls++;
    return structure;
  }
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

const baseCriteria: FilterCriteria = { include_resolved: true, include_descendants: false };
function input(over: Partial<Parameters<typeof getCommentsUseCase>[2]> = {}) {
  return { file: 'ABCXYZ', criteria: baseCriteria, as_markdown: true, node_depth: 0, limit: 50, offset: 0, ...over };
}

describe('getCommentsUseCase', () => {
  // Use case now returns the full requested page + counts (page / total_matching / offset);
  // clamp, warnings, next_offset and markdown rendering all moved to the tool layer.
  it('happy path: page with thread + resolved node name from structure', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input());
    const t1001 = out.page.find((t) => t.id === '1001');
    expect(t1001).toBeDefined();
    expect(t1001!.anchor).toMatchObject({ node_name: 'Button / Primary' });
    expect(out.total_matching).toBe(4);
    expect(out.page.length).toBe(4);
    expect(out.offset).toBe(0);
  });

  it('returns the full requested page as threads', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input({ as_markdown: false }));
    expect(out.page.length).toBe(4);
  });

  it('limit/offset slices the page (tool derives next_offset from offset+page)', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input({ limit: 2, offset: 0, as_markdown: false }));
    expect(out.page.length).toBe(2);
    expect(out.total_matching).toBe(4);
    expect(out.offset).toBe(0);
  });

  it('filters by author_id', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input({
      as_markdown: false,
      criteria: { ...baseCriteria, author_id: 'u-anna' },
    }));
    expect(out.page.map((t) => t.id).sort()).toEqual(['1001', '3001']);
  });

  it('message_contains filters', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input({
      as_markdown: false,
      criteria: { ...baseCriteria, message_contains: 'логотип' },
    }));
    expect(out.page.map((t) => t.id)).toEqual(['3001']);
  });

  it('include_resolved=false drops resolved 2001', async () => {
    const api = new FakeFigmaApi();
    const out = await getCommentsUseCase(api as unknown as FigmaApi, silent, input({
      as_markdown: false,
      criteria: { ...baseCriteria, include_resolved: false },
    }));
    expect(out.page.map((t) => t.id)).not.toContain('2001');
  });

  it('propagates FigmaApiError from getComments', async () => {
    const api = new FakeFigmaApi(new FigmaApiError('auth', 403, 'nope'));
    await expect(getCommentsUseCase(api as unknown as FigmaApi, silent, input())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('rejects invalid file', async () => {
    const api = new FakeFigmaApi();
    await expect(getCommentsUseCase(api as unknown as FigmaApi, silent, input({ file: '' }))).rejects.toThrow(/file is required/);
  });

  it('rejects since > until', async () => {
    const api = new FakeFigmaApi();
    await expect(
      getCommentsUseCase(api as unknown as FigmaApi, silent, input({ criteria: { ...baseCriteria, since: '2026-06-01T00:00:00Z', until: '2026-05-01T00:00:00Z' } })),
    ).rejects.toThrow(/since must be <= until/);
  });

  // more_available + auto_clamp + next_offset are now the tool layer's job (clamp measures the
  // DELIVERED serialization). See get-comments-tool.test.ts for those locks.
});
