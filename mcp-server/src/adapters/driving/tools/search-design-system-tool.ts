import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import type { RawTeamLibrary } from '../../../domain/figma-raw.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { mergeTeamLibraries, searchAssets, filterByLibraryFileKeys } from '../../../domain/design-system.js';
import { resolveConsumedLibraries } from '../../../domain/consumed-libraries.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { FigmaApiError } from '../../../ports/errors.js';
import { tokenStatusHint } from '../../../infrastructure/status-hint.js';

/** Accept a raw team id or a Figma team URL (figma.com/files/.../team/<id> or figma.com/team/<id>). */
function extractTeamId(input: string): string {
  const m = input.match(/\/team\/(\d+)/);
  return m ? m[1] : input.trim();
}

// Fan-out cap: searching every registered team multiplies REST calls (3 paginated each).
const MAX_TEAMS = 5;

/**
 * mapStatus's sentence for ONE refused team, plus the half this layer adds. Lifted out of the call
 * site unchanged so the fan-out can diagnose each team separately: it used to keep a single
 * `forbidden` error that every failing team overwrote, so with five teams the reader was handed one
 * remedy chosen by whichever request happened to settle last, with no team id anywhere in the text.
 * Round 2 made that worse rather than better - broadening the guard to kind 'auth' put a
 * RE-SCOPE remedy and a RE-ISSUE remedy in the same race, and those two are incompatible.
 *
 * The strings are untouched: for a single team this returns byte-for-byte what the inline version
 * produced, which is what keeps every composite row in tool-diagnosis-e2e.test.ts pinning the same
 * text it pinned before.
 */
function refusalDiagnosis(err: FigmaApiError): string {
  // The scope tail used to be appended unconditionally, which reads as a contradiction over a
  // plan-shaped 403: mapStatus says "re-issuing or re-scoping the token will not change it" and
  // this sentence then sent the reader to re-scope the token. Same guard as get_variables' 403
  // branch, for the same reason - the tail composes with a message this tool did not write.
  //
  // Ranked like reasonFamily, for the reason spelled out in get-variables-tool.ts: the plan tail
  // may only follow the message that names the plan and NOTHING else. When Figma named the token,
  // or named a scope alongside the plan, mapStatus's half has already declined to pick - so this
  // half names the specific scopes and picks nothing.
  const reason = err.upstreamReason ?? '';
  const tokenNamed = /invalid token/i.test(reason);
  const scopeNamed = /scope/i.test(reason);
  const planRaw = /limited by figma plan|incorrect account type/i.test(reason);
  const planNamed = !tokenNamed && !scopeNamed && planRaw;
  // When the ranking answered the token but Figma ALSO named a plan, the plan must not vanish from
  // the answer: a reader whose real problem is the plan would otherwise reissue a token and check
  // two scopes, and none of that can work. Same fix, same reason, as get_variables' token+plan tail.
  const planAlso = tokenNamed && planRaw
    ? 'Figma also named a plan or account-type limit, so a fresh token may not be enough'
      + ' on its own. '
    : '';
  return `${err.message} `
    + planAlso
    + (planNamed
      // mapStatus's plan sentence names "this file's Figma plan" - generic wording that is slightly
      // wrong here, because the call that failed was a TEAM endpoint. Correcting the subject is
      // this layer's job; repeating its "ask the owner" instruction in different words would not be.
      ? 'Published-library reads are one of the endpoints a Figma plan can exclude, and'
        + ' this call was about a team rather than a file.'
        + ' Ask whoever owns that team in Figma whether its plan covers published-library reads.'
      // The scope-family message above names this server's generic read pair, written for five call
      // sites at once; for this one they are the wrong scopes, and a reader who finds them present
      // concludes the scope is not the problem. Same correction get_variables makes, and only on
      // the kind where that sentence was actually emitted - it would be a claim about a sentence
      // that is not there otherwise.
      : (err.kind === 'auth'
        ? 'Figma named a scope, and the scopes named above are this server\'s generic read pair rather than this call\'s. '
        : '')
        + 'Reading a team library needs team_library_content:read (or file_content:read) and access to that team.'
        + ' Check those two on the Personal access tokens page in Figma, and open the team in Figma as that account.'
        + (planAlso ? ' Then ask whoever owns that team whether its plan covers published-library reads.' : ''));
}

const InputSchema = {
  team_id: z.string().min(1).optional().describe('Figma team id OR a team URL (id is extracted). Optional only on the multi-tenant server, which falls back to the design-system teams you registered there; on stdio and single-tenant it is required.'),
  query: z.string().min(1).describe('Search terms; spaces = AND. Matches component/style name, description, page. Lexical, not semantic - try short fragments ("button", "space", "toast").'),
  file: z.string().min(1).optional().describe('Figma file URL/key - narrows results to the libraries this file actually consumes (does not add teams).'),
  limit: z.number().int().min(1).max(50).default(15).describe('Max matches (default 15)'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerSearchDesignSystemTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'search_design_system',
    {
      description: 'Search published design-system libraries (components, component sets, styles) by name/description. team_id is required on the stdio and single-tenant servers; only the multi-tenant server can omit it, and there it falls back to the design-system teams you registered. Pass a `file` to narrow results to the libraries that file consumes. Returns matches with key, kind, library file, node_id, page and source team_id - use node_id with get_design_context. Lexical name search; run short queries.',
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
        // Recorded BY INDEX, never in settle order: these requests run concurrently, and a message
        // that names teams (or a skipped_teams array) must not depend on which one happened to
        // finish first. Every failure is kept WITH its team id - the previous single `forbidden`
        // slot lost both the attribution and every refusal but the last.
        const failures: ({ teamId: string; err: unknown } | undefined)[] = new Array(teams.length);
        await Promise.all(teams.map(async (teamId, i) => {
          try {
            libsByTeam.push({ teamId, lib: await api.getTeamLibrary(teamId) });
          } catch (err) {
            if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
            failures[i] = { teamId, err };
          }
        }));
        const failed = failures.filter((f): f is { teamId: string; err: unknown } => f !== undefined);
        const skipped = failed.map(({ teamId, err }) =>
          ({ team_id: teamId, reason: err instanceof FigmaApiError ? err.kind : 'error' }));
        // Keep the ERRORS, not a boolean: mapStatus already put Figma's own reason into each
        // message (and into upstreamReason), and a boolean discards it before it can be shown - so
        // a dead token was reported here as a missing team scope.
        //
        // BOTH 403 kinds. mapStatus routes a scope-family 403 to kind 'auth' - the only auth-403 it
        // produces - so a 403 that named the scope outright was dropped here and fell out as a bare
        // mapStatus message with no team-scope sentence and no runnable command. The kind is read,
        // never moved.
        const refused = failed.filter((f): f is { teamId: string; err: FigmaApiError } =>
          f.err instanceof FigmaApiError
          && (f.err.kind === 'forbidden' || (f.err.kind === 'auth' && f.err.status === 403)));
        if (libsByTeam.length === 0) {
          if (refused.length > 0) {
            // Same closing check as get_variables' 403, derived the same way and for the same
            // reason: every branch of the diagnosis ends in Figma's web UI, and none of them ends
            // at anything the reader can run against this instance.
            const pointer = tokenStatusHint(undefined, { perCallToken: args.figma_token !== undefined });
            const diagnosed = refused.map(({ teamId, err }) => ({ teamId, text: refusalDiagnosis(err) }));
            // Teams that failed for something other than a 403 (a 404, a network error): named, but
            // NOT folded into the diagnosis, because nothing above is a claim about them. Without
            // this they reached the reader nowhere at all - skipped_teams is built into the SUCCESS
            // result, and this path never gets there.
            const undiagnosed = failed
              .filter((f) => !refused.some((r) => r.teamId === f.teamId))
              .map((f) => f.teamId);
            const others = undiagnosed.length
              ? ` These teams failed for some other reason and are not diagnosed above: ${undiagnosed.join(', ')}.`
              : '';
            const distinct = new Set(diagnosed.map((d) => d.text));
            if (distinct.size === 1) {
              // One cause. With a single team the text is byte-for-byte what it has always been;
              // with several, the lead says the diagnosis covers all of them and names which - a
              // reader who is told "the token is dead" about an unnamed subset of five teams cannot
              // act on it.
              const lead = diagnosed.length === 1
                ? ''
                : `All ${diagnosed.length} teams (${diagnosed.map((d) => d.teamId).join(', ')}) were refused the same way. `;
              throw new Error(`${lead}${diagnosed[0].text}${others} ${pointer}`);
            }
            // The causes DISAGREE, and their remedies are incompatible - re-scoping the token is
            // the fix for one and provably not the fix for another. Picking one and stating it as
            // the answer is what the single `forbidden` slot did silently, by settle order. So the
            // single remedy is dropped rather than chosen: every team is named with its own cause,
            // which is more use to the reader than a tidy sentence that is wrong for some of them.
            throw new Error(
              `Figma refused all ${diagnosed.length} team library reads, and not for the same reason - there is no single fix here, so each team is named with its own. `
              + diagnosed.map((d) => `Team ${d.teamId}: ${d.text}`).join(' ')
              + others
              + ` ${pointer}`,
            );
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
