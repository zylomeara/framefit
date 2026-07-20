import { describe, it, expect } from 'vitest';
import { summarizeCommentsUseCase } from '../../src/application/summarize-comments.js';
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
const base: FilterCriteria = { include_resolved: true, include_descendants: false };

class FakeApi {
  fileStructureCalls = 0;
  constructor(private comments: RawComment[] | Error = rawComments, private structErr?: Error) {}
  async getComments(): Promise<RawComment[]> {
    if (this.comments instanceof Error) throw this.comments;
    return this.comments;
  }
  async resolveNodes(_k: string, ids: string[]): Promise<NodeRefMap> {
    return ids.length ? new Map() : new Map();
  }
  async getFileStructure(): Promise<FileStructure> {
    this.fileStructureCalls++;
    if (this.structErr) throw this.structErr;
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

function input(over: Partial<Parameters<typeof summarizeCommentsUseCase>[2]> = {}) {
  return { file: 'ABCXYZ', criteria: base, node_depth: 0, top_n: 10, ...over };
}

describe('summarizeCommentsUseCase', () => {
  it('returns aggregates for the whole file', async () => {
    const out = await summarizeCommentsUseCase(new FakeApi() as unknown as FigmaApi, silent, input());
    expect(out.total).toBe(4);
    expect(out.by_author.length).toBeGreaterThan(0);
    const anchorSum = out.by_anchor.canvas_point + out.by_anchor.canvas_region + out.by_anchor.node + out.by_anchor.node_region;
    expect(anchorSum).toBe(out.total);
  });

  it('applies filters before aggregating', async () => {
    const out = await summarizeCommentsUseCase(new FakeApi() as unknown as FigmaApi, silent, input({
      criteria: { ...base, author_id: 'u-anna' },
    }));
    expect(out.total).toBe(2);
  });

  it('loads structure lazily (node anchors present in fixture)', async () => {
    const api = new FakeApi();
    await summarizeCommentsUseCase(api as unknown as FigmaApi, silent, input());
    expect(api.fileStructureCalls).toBe(1);
  });

  it('propagates structure failure (fail-fast)', async () => {
    const api = new FakeApi(rawComments, new FigmaApiError('rate_limited', 429, 'slow'));
    await expect(summarizeCommentsUseCase(api as unknown as FigmaApi, silent, input())).rejects.toMatchObject({ kind: 'rate_limited' });
  });
});
