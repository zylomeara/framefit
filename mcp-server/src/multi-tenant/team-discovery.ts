// mcp-server/src/multi-tenant/team-discovery.ts
// Enumerate a team's projects → files, probe /variables/local, and keep files that
// expose variables (i.e. variable libraries). A file that won't load (timeout/forbidden)
// is simply skipped — it isn't a usable variable library for our graph.
import type { FigmaApi } from '../ports/figma-api.js';

export interface DiscoveredLibrary { file_key: string; name: string; vars: number }

export async function discoverLibraries(api: FigmaApi, teamId: string): Promise<DiscoveredLibrary[]> {
  const out: DiscoveredLibrary[] = [];
  const projects = await api.getTeamProjects(teamId);
  for (const p of projects) {
    let files: { key: string; name: string }[];
    try {
      files = await api.getProjectFiles(p.id);
    } catch {
      continue; // a project we can't list (forbidden/deleted) — skip it, like a forbidden file
    }
    for (const f of files) {
      let n = 0;
      try {
        const raw = await api.getVariablesLocal(f.key);
        n = Object.keys(raw?.meta?.variables ?? {}).length;
      } catch {
        n = 0;
      }
      if (n > 0) out.push({ file_key: f.key, name: f.name, vars: n });
    }
  }
  return out;
}
