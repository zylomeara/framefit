// mcp-server/src/multi-tenant/library-sync.ts
// Orchestrates a headless sync: per registered team → enumerate projects/files →
// fetch each file's raw /variables/local ONCE → if it has published variables, store it
// in the graph. The single fetch serves both "is this a variable library?" and parsing,
// so a library is never fetched twice. A project/file that fails to load is logged +
// skipped (never fails the whole sync). High timeout for large libraries.
import type { FigmaApi } from '../ports/figma-api.js';
import type { Logger } from '../infrastructure/logger.js';

export interface SyncDeps {
  buildApi: (pat: string, timeoutMs?: number) => FigmaApi;
  getPat: (userId: string) => Promise<string | null>;
  listTeams: (userId: string) => Promise<string[]>;
  setLibraries: (userId: string, teamId: string, libs: { file_key: string; name: string; vars: number }[], preserve?: string[] | 'all') => Promise<void>;
  replaceLibrary: (userId: string, fileKey: string, vars: unknown[], colls: unknown[]) => Promise<void>;
  logger: Logger;
}

const SYNC_TIMEOUT_MS = 120000; // large libraries need a high timeout

export async function syncUser(userId: string, deps: SyncDeps, opts?: { teamId?: string }): Promise<{ libraries: number; variables: number; skipped: number }> {
  const pat = await deps.getPat(userId);
  if (!pat) return { libraries: 0, variables: 0, skipped: 0 };
  const api = deps.buildApi(pat, SYNC_TIMEOUT_MS);
  let libraries = 0, variables = 0, skipped = 0;
  const teams = await deps.listTeams(userId);
  // Optional single-team filter: sync just one registered team. If opts.teamId isn't
  // registered, targets is empty → zeros (no behavior change for the all-teams path).
  const targets = opts?.teamId ? teams.filter((t) => t === opts.teamId) : teams;
  for (const teamId of targets) {
    let projects: { id: string; name: string }[];
    try { projects = await api.getTeamProjects(teamId); }
    catch (e) { deps.logger.warn({ teamId, err: (e as Error).message }, 'sync.discover_failed'); continue; }
    const registryLibs: { file_key: string; name: string; vars: number }[] = [];
    const preserveKeys: string[] = [];
    let enumerationIncomplete = false;
    for (const p of projects) {
      let files: { key: string; name: string }[];
      try { files = await api.getProjectFiles(p.id); }
      catch (e) { deps.logger.warn({ project: p.id, err: (e as Error).message }, 'sync.project_skipped'); enumerationIncomplete = true; continue; }
      for (const f of files) {
        let raw: any;
        // ONE fetch per file — reused for both the library check and parsing.
        try { raw = await api.getVariablesLocal(f.key); }
        catch (e) { deps.logger.warn({ file: f.key, err: (e as Error).message }, 'sync.library_skipped'); skipped++; preserveKeys.push(f.key); continue; }
        const meta = raw?.meta ?? {};
        const vars = Object.values(meta.variables ?? {}).filter((v: any) => v.key).map((v: any) => ({
          library_key: v.key, local_id: v.id, collection_id: v.variableCollectionId,
          values_by_mode: v.valuesByMode, name: v.name, resolved_type: v.resolvedType,
        }));
        if (vars.length === 0) continue; // not a usable variable library (no published keys) — LEGITIMATE eviction
        const colls = Object.values(meta.variableCollections ?? {}).map((c: any) => ({ collection_id: c.id, default_mode: c.defaultModeId, modes: c.modes, name: c.name ?? '', key: c.key ?? '' }));
        registryLibs.push({ file_key: f.key, name: f.name, vars: vars.length });
        await deps.replaceLibrary(userId, f.key, vars, colls);
        libraries++; variables += vars.length;
      }
    }
    // Eviction only under full knowledge: an error must never delete registry rows (spec).
    const preserve = enumerationIncomplete ? ('all' as const) : (preserveKeys.length ? preserveKeys : undefined);
    if (preserve) deps.logger.info({ teamId, preserved: preserve === 'all' ? 'all' : preserve.length }, 'sync.registry_preserved');
    await deps.setLibraries(userId, teamId, registryLibs, preserve);
  }
  deps.logger.info({ userId, libraries, variables, skipped }, 'sync.done');
  return { libraries, variables, skipped };
}
