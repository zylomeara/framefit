import { describe, it, expect, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';

const logger = { info() {}, warn() {}, error() {}, debug() {}, child() { return logger; } } as any;

describe('FigmaRestAdapter teams/projects', () => {
  it('getTeamProjects hits /teams/:id/projects and returns projects', async () => {
    const api = new FigmaRestAdapter('tok', logger);
    (api as any).request = vi.fn().mockResolvedValue({ projects: [{ id: '1', name: 'DS' }] });
    const r = await api.getTeamProjects('TEAM');
    expect((api as any).request).toHaveBeenCalledWith('https://api.figma.com/v1/teams/TEAM/projects');
    expect(r).toEqual([{ id: '1', name: 'DS' }]);
  });
  it('getProjectFiles hits /projects/:id/files and returns files', async () => {
    const api = new FigmaRestAdapter('tok', logger);
    (api as any).request = vi.fn().mockResolvedValue({ files: [{ key: 'k', name: 'DS Colors' }] });
    const r = await api.getProjectFiles('99');
    expect((api as any).request).toHaveBeenCalledWith('https://api.figma.com/v1/projects/99/files');
    expect(r).toEqual([{ key: 'k', name: 'DS Colors' }]);
  });
});
