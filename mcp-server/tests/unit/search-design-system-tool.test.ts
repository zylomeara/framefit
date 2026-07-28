import { describe, it, expect } from 'vitest';
import { registerSearchDesignSystemTool } from '../../src/adapters/driving/tools/search-design-system-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(getTeamLibrary: FigmaApi['getTeamLibrary']) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getNodesRaw: async () => ({ nodes: {} }), getImages: async () => ({ images: {} }),
      getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getFileComponents: async () => [], getTeamLibrary,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
  };
  registerSearchDesignSystemTool(server, deps);
  return (a: any): Promise<any> => call('search_design_system', a);
}

function mk(opts: {
  getTeamLibrary?: FigmaApi['getTeamLibrary'];
  registeredTeams?: string[];
  getDocumentRaw?: FigmaApi['getDocumentRaw'];
  getComponent?: FigmaApi['getComponent'];
}) {
  const { server, call } = makeFakeMcpServer();
  const base = {
    getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
    getDocumentRaw: opts.getDocumentRaw ?? (async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'D', type: 'DOCUMENT' } })),
    getNodesRaw: async () => ({ nodes: {} }), getImages: async () => ({ images: {} }),
    getVariablesLocal: async () => ({}), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
    getFileComponents: async () => [],
    getTeamLibrary: opts.getTeamLibrary ?? (async () => ({ components: [], componentSets: [], styles: [] })),
    getComponent: opts.getComponent ?? (async (key: string) => ({ key, file_key: 'LIB', node_id: '7:7', name: 'C' })),
  };
  const deps: ToolDeps = {
    buildApi: () => ({ ...base } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
    ...(opts.registeredTeams ? { registeredTeams: { list: async () => opts.registeredTeams! } } : {}),
  };
  registerSearchDesignSystemTool(server, deps);
  return (a: any): Promise<any> => call('search_design_system', a);
}

describe('search_design_system tool', () => {
  it('returns scored matches for a query', async () => {
    const run = harness(async () => ({
      components: [{ key: 'c1', file_key: 'F', node_id: '1:1', name: 'Button', description: 'primary' }],
      componentSets: [], styles: [],
    }));
    const res = await run({ team_id: 'T1', query: 'button' });
    const text = res.content[0].text as string;
    expect(text).toContain('Button');
    expect(text).toContain('"node_id"');
  });

  it('reports zero matches cleanly', async () => {
    const run = harness(async () => ({ components: [], componentSets: [], styles: [] }));
    const res = await run({ team_id: 'T1', query: 'nope' });
    expect(res.content[0].text).toContain('"count":0');
  });

  it('extracts the team id from a Figma team URL', async () => {
    let seenTeam = '';
    const run = harness(async (teamId) => { seenTeam = teamId; return { components: [], componentSets: [], styles: [] }; });
    const res = await run({ team_id: 'https://www.figma.com/files/1379448576167521267/team/1593514226249264149', query: 'x' });
    expect(seenTeam).toBe('1593514226249264149');
    expect(res.content[0].text).toContain('"team_id":"1593514226249264149"');
  });

  it('maps forbidden to a scope/Enterprise hint', async () => {
    const run = harness(async () => { throw new FigmaApiError('forbidden', 403, 'no'); });
    const res = await run({ team_id: 'T1', query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/team_library_content:read|access/i);
  });

  it('returns thumbnail_url when component has one', async () => {
    const run = harness(async () => ({
      components: [{ key: 'c1', file_key: 'F', node_id: '1:1', name: 'Card', description: '', thumbnail_url: 'https://cdn.example.com/thumb.png' }],
      componentSets: [], styles: [],
    }));
    const res = await run({ team_id: 'T1', query: 'card' });
    expect(res.content[0].text).toContain('https://cdn.example.com/thumb.png');
  });

  it('falls back to the user\'s registered teams when team_id is omitted', async () => {
    const run = mk({
      registeredTeams: ['T1', 'T2'],
      getTeamLibrary: async (teamId: string) => teamId === 'T1'
        ? { components: [{ key: 'c1', file_key: 'libA', node_id: '1:1', name: 'Button', description: '' }], componentSets: [], styles: [] }
        : { components: [{ key: 'c2', file_key: 'libB', node_id: '2:1', name: 'Card', description: '' }], componentSets: [], styles: [] },
    });
    const res = await run({ query: 'button' });
    const body = JSON.parse(res.content[0].text);
    expect(body.source).toBe('registered');
    expect(body.team_ids).toEqual(expect.arrayContaining(['T1', 'T2']));
    expect(body.matches.find((m: any) => m.name === 'Button').team_id).toBe('T1');
  });

  it('errors clearly when no team_id and no registered teams', async () => {
    const run = mk({ registeredTeams: [] });
    const res = await run({ query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/register/i);
  });

  it('skips a forbidden team but returns results from the others', async () => {
    const run = mk({
      registeredTeams: ['T1', 'T2'],
      getTeamLibrary: async (teamId: string) => {
        if (teamId === 'T1') throw new FigmaApiError('forbidden', 403, 'no');
        return { components: [{ key: 'c2', file_key: 'libB', node_id: '2:1', name: 'Button', description: '' }], componentSets: [], styles: [] };
      },
    });
    const res = await run({ query: 'button' });
    const body = JSON.parse(res.content[0].text);
    expect(body.count).toBe(1);
    expect(body.skipped_teams.some((s: any) => s.team_id === 'T1')).toBe(true);
  });

  it('file param narrows results to the libraries that file consumes', async () => {
    const run = mk({
      registeredTeams: ['T1'],
      getTeamLibrary: async () => ({
        components: [
          { key: 'c1', file_key: 'libX', node_id: '1:1', name: 'ButtonX', description: '' },
          { key: 'c2', file_key: 'libY', node_id: '2:1', name: 'ButtonY', description: '' },
        ], componentSets: [], styles: [],
      }),
      getDocumentRaw: async () => ({ name: 'F', lastModified: 'X', version: '1', document: { id: '0:0', name: 'D', type: 'DOCUMENT' }, components: { 'C:1': { key: 'k1', remote: true } } } as any),
      getComponent: async () => ({ key: 'k1', file_key: 'libX', node_id: '9:9', name: 'X' }),
    });
    const res = await run({ query: 'button', file: 'somefile' });
    const body = JSON.parse(res.content[0].text);
    const names = body.matches.map((m: any) => m.name);
    expect(names).toContain('ButtonX');
    expect(names).not.toContain('ButtonY');
  });
});
