import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import type { RawTeamLibrary } from '../../../domain/figma-raw.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { mergeTeamLibraries, searchAssets, filterByLibraryFileKeys } from '../../../domain/design-system.js';
import { resolveConsumedLibraries } from '../../../domain/consumed-libraries.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { FigmaApiError } from '../../../ports/errors.js';

/** Accept a raw team id or a Figma team URL (figma.com/files/.../team/<id> or figma.com/team/<id>). */
function extractTeamId(input: string): string {
  const m = input.match(/\/team\/(\d+)/);
  return m ? m[1] : input.trim();
}

// Fan-out cap: searching every registered team multiplies REST calls (3 paginated each).
const MAX_TEAMS = 5;

const InputSchema = {
  team_id: z.string().min(1).optional().describe('Figma team id OR a team URL (id is extracted). Optional: when omitted, falls back to your registered design-system teams.'),
  query: z.string().min(1).describe('Search terms; spaces = AND. Matches component/style name, description, page. Lexical, not semantic — try short fragments ("button", "space", "toast").'),
  file: z.string().min(1).optional().describe('Figma file URL/key — narrows results to the libraries this file actually consumes (does not add teams).'),
  limit: z.number().int().min(1).max(50).default(15).describe('Max matches (default 15)'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerSearchDesignSystemTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_design_system',
    {
      description: 'Search published design-system libraries (components, component sets, styles) by name/description. team_id is OPTIONAL: without it, the tool searches your registered DS teams. Pass a `file` to narrow results to the libraries that file consumes. Returns matches with key, kind, library file, node_id, page and source team_id — use node_id with get_design_context. Lexical name search; run short queries.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('search_design_system', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        // Resolve candidate team ids: explicit team_id → else the user's registered teams.
        let candidates: string[];
        let source: 'explicit' | 'registered';
        if (args.team_id) {
          candidates = [extractTeamId(args.team_id)];
          source = 'explicit';
        } else if (deps.registeredTeams) {
          candidates = await deps.registeredTeams.list();
          source = 'registered';
          if (candidates.length === 0) {
            throw new Error('No team_id given and you have no registered design-system teams. Register one in the portal (Add Team), or pass team_id / a team URL.');
          }
        } else {
          throw new Error('team_id is required. Pass a Figma team id or a team URL (the deployment has no registered-team fallback).');
        }
        const teams = [...new Set(candidates)].slice(0, MAX_TEAMS);
        const truncated = candidates.length > teams.length;

        const api = deps.buildApi(token);
        // Fan out across candidate teams, failing soft per team so one inaccessible team
        // doesn't sink the whole search.
        const libsByTeam: { teamId: string; lib: RawTeamLibrary }[] = [];
        const skipped: { team_id: string; reason: string }[] = [];
        let sawForbidden = false;
        await Promise.all(teams.map(async (teamId) => {
          try {
            libsByTeam.push({ teamId, lib: await api.getTeamLibrary(teamId) });
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            if (err instanceof FigmaApiError && err.kind === 'forbidden') sawForbidden = true;
            skipped.push({ team_id: teamId, reason: err instanceof FigmaApiError ? err.kind : 'error' });
          }
        }));
        if (libsByTeam.length === 0) {
          if (sawForbidden) {
            throw new Error('Figma denied team library access. The token needs team_library_content:read (or file_content:read) and access to that team.');
          }
          throw new Error('No team libraries could be read for the resolved team(s). Check the team id(s) and token access.');
        }

        let assets = mergeTeamLibraries(libsByTeam);

        // Optional file narrowing: keep only assets from libraries this file consumes.
        let fileKey: string | undefined;
        if (args.file) {
          const parsed = parseFileKey(args.file);
          if (!parsed.ok) throw new Error(parsed.error);
          fileKey = parsed.value;
          const consumed = await resolveConsumedLibraries(api, fileKey);
          assets = filterByLibraryFileKeys(assets, new Set(consumed.libraries.map((l) => l.file_key)));
        }

        const matches = searchAssets(assets, args.query, args.limit);
        const out: Record<string, unknown> = { query: args.query, source, count: matches.length, matches };
        // Keep the single-team `team_id` shape when exactly one team was searched.
        if (teams.length === 1) out.team_id = teams[0]; else out.team_ids = teams;
        if (fileKey) out.file = fileKey;
        if (skipped.length) out.skipped_teams = skipped;
        if (truncated) out.note = `Searched the first ${teams.length} of ${candidates.length} registered teams; pass team_id to target a specific one.`;
        return jsonResult(out);
      }, deps.noTokenHint),
  );
}
