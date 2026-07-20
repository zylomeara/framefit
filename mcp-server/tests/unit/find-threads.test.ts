import { describe, it, expect } from 'vitest';
import { findThreadsUseCase } from '../../src/application/find-threads.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
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
  async getComments(): Promise<RawComment[]> { return rawComments; }
  async resolveNodes(_k: string, ids: string[]): Promise<NodeRefMap> { return ids.length ? new Map() : new Map(); }
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

function input(over: Partial<Parameters<typeof findThreadsUseCase>[2]> = {}) {
  return { file: 'ABCXYZ', criteria: base, query: 'радиус', fuzzy: false, limit: 10, node_depth: 0, ...over };
}

describe('findThreadsUseCase', () => {
  it('finds the thread mentioning "радиус"', async () => {
    const out = await findThreadsUseCase(new FakeApi() as unknown as FigmaApi, silent, input());
    expect(out.query).toBe('радиус');
    expect(out.matches.map((m) => m.thread_id)).toContain('1001');
  });

  it('respects limit', async () => {
    const out = await findThreadsUseCase(new FakeApi() as unknown as FigmaApi, silent, input({ query: 'а', limit: 1 }));
    expect(out.matches.length).toBeLessThanOrEqual(1);
  });

  it('applies filters before searching', async () => {
    const out = await findThreadsUseCase(new FakeApi() as unknown as FigmaApi, silent, input({
      query: 'сетки',
      criteria: { ...base, include_resolved: false },
    }));
    expect(out.matches.map((m) => m.thread_id)).not.toContain('2001');
  });
});
