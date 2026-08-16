import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, textResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { clampToBudget, responseTooLargeResult } from './response-budget.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeCompoundNodeId, COMPOUND_NODE_ID_RE } from '../../../domain/node-id.js';
import { listTokens, listTokensForIds, collectNodeVariableIds } from '../../../domain/variables.js';
import { extractLibraryKey } from '../../../domain/variable-snapshot.js';
import { FigmaApiError, TOO_LARGE_REASON_RE } from '../../../ports/errors.js';
import { tokenStatusHint } from '../../../infrastructure/status-hint.js';
import { summarizeTokens, filterTokens, dedupeTokens, canonicalizeCollections } from '../../../domain/variables-summary.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(COMPOUND_NODE_ID_RE, 'expected "1:42", "1-42", or a nested-instance id like "I12:340;56:7890"').optional().describe('When set, return ONLY the variables referenced by this node subtree (the headless analogue of get_variable_defs). Omit for the whole-file token catalog.'),
  depth: z.number().int().min(1).max(8).default(4).describe('Subtree depth scanned for variable references (node_id mode only).'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-call Figma request timeout in ms (default 90000). The variables endpoint can be slow on large files - raise toward the 120000 max if you still hit timeouts.'),
  collection: z.string().optional().describe('Filter tokens by collection name (case-insensitive substring match).'),
  name: z.string().optional().describe('Filter tokens by name (case-insensitive substring match).'),
  type: z.string().optional().describe('Filter tokens by resolved type (case-insensitive exact match, e.g. COLOR, FLOAT, STRING, BOOLEAN).'),
  unresolved_only: z.boolean().default(false).describe('When true, return only tokens whose cross-library alias could not be resolved (value:null, alias:true). Useful to identify which teams need to be registered.'),
  limit: z.number().int().min(1).max(1000).default(200).describe('Maximum number of tokens to return (default 200, max 1000).'),
  offset: z.number().int().min(0).default(0).describe('Number of tokens to skip for pagination (default 0).'),
  figma_token: z.string().min(1).optional().describe('Override Figma PAT'),
};

export function registerGetVariablesTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'get_variables',
    {
      description: 'List design tokens (Figma variables) in a file: name, type, default-mode value (colors as hex), and collection. Pass node_id to return ONLY the variables a node subtree references (the headless analogue of get_variable_defs) instead of the whole-file catalog. Returns a summary header (total, resolved_via buckets {local,graph,snapshot}, unresolved count, by_type counts) plus optional filters (collection, name, type, unresolved_only) and pagination (limit/offset). Duplicate rows are deduped and case-variant collection names are unified. Aliases within the file are resolved. Cross-library aliases are resolved headless via the registered library graph: when the source library\'s team is registered, the token returns value:<hex>, resolved_via:"graph", and source_library (the source file key). Otherwise it stays honest - value:null, alias:true, alias_of:<VariableID> - meaning that library\'s team is not registered yet (register it to resolve). Access to the Variables REST API depends on the file\'s Figma plan, on the token being valid, and on the token carrying file_variables:read - a 403 here is one of several causes, and the error message quotes Figma\'s own reason. Raise timeout_ms on large files. Multi-mode tokens (collections with >1 mode) carry mode_dependent:true and modes:{<modeName>:<hex>} - value is the DEFAULT mode; do not treat it as the on-screen value without checking the node\'s mode (see get_design_context).',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('get_variables', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const parsed = parseFileKey(args.file);
        if (!parsed.ok) throw new Error(parsed.error);
        try {
          const api = deps.buildApi(token, args.timeout_ms);
          const resp = await api.getVariablesLocal(parsed.value);
          // Build the single-tenant env library graph before the first cross-library resolve
          // (idempotent/fail-soft; a no-op for the MT wrappers and when no graph is configured).
          // Placed ABOVE the `deps.variableGraph || deps.variableSnapshot` guard so it dominates the
          // only variableGraph read site (deps.variableGraph.resolve below).
          await deps.variableGraph?.ensureReady?.();
          // Resolve cross-library aliases. Graph-first (headless, sync); for keys the
          // graph can't resolve, fall back to the per-user snapshot (v2a) — which covers
          // files Figma REST rejects as "Request too large". Degrades to honest aliases on
          // error (except rate_limited, which we rethrow).
          let resolve:
            | ((aliasOf: string) => { value: string | number | boolean; resolved_via?: 'snapshot' | 'graph'; source_library?: string; modes?: Record<string, string> } | undefined)
            | undefined;
          if (deps.variableGraph || deps.variableSnapshot) {
            try {
              const aliasIds = listTokens(resp).filter((t) => t.alias && t.alias_of).map((t) => t.alias_of!) as string[];
              const keys = [...new Set(aliasIds.map(extractLibraryKey).filter((k): k is string => k !== null))];
              if (keys.length) {
                const graphHits = new Map<string, { value: string; name?: string; sourceLibrary?: string; modes?: Record<string, string> }>();
                if (deps.variableGraph) {
                  for (const k of keys) {
                    const hit = deps.variableGraph.resolve(k);
                    if (hit) graphHits.set(k, { value: hit.value, name: hit.name, sourceLibrary: hit.sourceLibrary, modes: hit.modesByName });
                  }
                }
                const missed = keys.filter((k) => !graphHits.has(k));
                const snapHits = deps.variableSnapshot && missed.length ? await deps.variableSnapshot.lookup(missed) : undefined;
                if (graphHits.size || (snapHits && snapHits.size)) {
                  resolve = (aliasOf) => {
                    const k = extractLibraryKey(aliasOf);
                    if (!k) return undefined;
                    const g = graphHits.get(k);
                    if (g) return { value: g.value, resolved_via: 'graph', source_library: g.sourceLibrary,
                      ...(g.modes && Object.keys(g.modes).length > 1 ? { modes: g.modes } : {}) };
                    const s = snapHits?.get(k);
                    return s?.value !== undefined ? { value: s.value, resolved_via: 'snapshot' } : undefined;
                  };
                }
              }
            } catch (err) {
              if (err instanceof FigmaApiError && err.kind === 'rate_limited') throw err;
              deps.logger.info({ err: (err as Error).message }, 'get_variables.alias_resolution_unavailable');
            }
          }
          // Node-scoped (only variables the node subtree references) or whole-file catalog.
          let allTokens;
          if (args.node_id) {
            const nid = normalizeCompoundNodeId(args.node_id);
            const nodes = await api.getNodesRaw(parsed.value, [nid], args.depth ?? 4);
            const entry = nodes.nodes[nid];
            if (!entry) throw new Error(`node ${nid} not found in file`);
            allTokens = listTokensForIds(resp, collectNodeVariableIds(entry.document), resolve);
          } else {
            allTokens = listTokens(resp, resolve);
          }
          // Normalize collection casing, then collapse duplicate (name,collection,value,type) rows.
          allTokens = dedupeTokens(canonicalizeCollections(allTokens));
          const summary = summarizeTokens(allTokens);

          // Apply filters
          const filtered = filterTokens(allTokens, {
            collection: args.collection,
            name: args.name,
            type: args.type,
            unresolved_only: args.unresolved_only,
          });

          // Pagination
          const offset = args.offset ?? 0;
          const limit = args.limit ?? 200;
          const page = filtered.slice(offset, offset + limit);

          // Attach hint to unresolved tokens
          const pageTokens = page.map((t) =>
            t.alias && t.value === null
              ? { ...t, hint: 'This token aliases a variable from an external library that is not yet registered. Register the source team to resolve it.' }
              : t,
          );

          // Measure and return the exact delivered envelope so the clamp accounts for the real
          // pagination cursor and its own clamped marker.
          const budget = deps.maxResultChars ?? 40000;
          const result = clampToBudget(pageTokens, budget, (tokens) => {
            const next_offset = offset + tokens.length < filtered.length ? offset + tokens.length : null;
            return serializeForDelivery({
              summary,
              total_matching: filtered.length,
              returned: tokens.length,
              next_offset,
              tokens,
              ...(tokens.length < pageTokens.length ? { clamped: true } : {}),
            });
          });
          if (result.kind === 'first_item_oversize' || result.kind === 'envelope_oversize') {
            return responseTooLargeResult(result.kind);
          }
          return textResult(result.serialized);
        } catch (err) {
          // BOTH 403 kinds, not just 'forbidden'. mapStatus routes a 403 whose reason names a scope
          // (and neither the token nor a plan) to kind 'auth' - that is the ONLY auth-403 it
          // produces - so the scope-family 403, the one case where Figma told us exactly what is
          // wrong, was the one case that bypassed this branch entirely and ended at no runnable
          // command at all. The kind is READ here, never moved: nothing in this file changes what
          // mapStatus classifies.
          if (err instanceof FigmaApiError && (err.kind === 'forbidden' || (err.kind === 'auth' && err.status === 403))) {
            // PRESERVE err.message - it already carries the bounded, sanitized upstream reason that
            // mapStatus parsed out of Figma's body. The old code threw a brand-new Error with the
            // Enterprise sentence, discarding both the message and the reason, so a user whose
            // 90-day PAT had expired was told to buy a subscription. Only Figma's OWN plan-shaped
            // reasons may be answered as a plan problem; everything else names what this endpoint
            // additionally needs and stops.
            // FIVE tails, because the tail composes with a message this tool did not write and the
            // reader gets both halves. mapStatus answers a 403 in one of several ways, and no single
            // tail follows them all:
            //   - Figma named the token             -> its message already excludes everything else;
            //   - Figma named the token AND a plan  -> the ranking answers the token and says
            //     nothing about the plan, so a reader whose real problem IS the plan reissues a
            //     token and checks a scope, and neither can work. The ranking is right about which
            //     cause to LEAD with and wrong to be the whole answer, so this tail carries the one
            //     it dropped. (Found by writing the triple-signal row, not by reasoning: the pair
            //     rows only asserted that the two halves do not contradict, and an OMISSION is not a
            //     contradiction.)
            //   - Figma named the plan/account type -> its message already excludes the token;
            //   - Figma named BOTH that and a scope -> its message says it cannot tell which, so a
            //     tail that picks one takes the choice back;
            //   - Figma named nothing readable      -> its message enumerates the possibilities, and
            //     an endpoint-specific tail mentioning only the scope leaves that enumeration
            //     INCOMPLETE, contradicting this tool's own corrected description in the same
            //     context window. The plan belongs in that list; it is a possibility there, not a
            //     verdict, which is the distinction the Enterprise sentence lost.
            //
            // The ORDER MIRRORS reasonFamily's ranking (token, then plan, then scope) and that is
            // load-bearing: testing the plan first, as the first version did, contradicted the half
            // above it on any body naming two things - over `Invalid token, incorrect account type`
            // mapStatus said the token was revoked and this tail answered "rather than a token
            // problem". A tail composing with a ranked classifier has to be ranked the same way.
            //
            // Not shared code with reasonFamily. Both layers already import from domain/, so a
            // shared constant WAS available and would have violated no boundary - this is a choice,
            // not a constraint. It is made because a shared constant would not have caught a single
            // one of these contradictions: every one of them was a pair of individually correct
            // sentences, and only the composite rows in tool-diagnosis-e2e.test.ts see those.
            const reason = err.upstreamReason ?? '';
            const tokenNamed = /invalid token/i.test(reason);
            const scopeNamed = /scope/i.test(reason);
            const planNamed = /limited by figma plan|incorrect account type/i.test(reason);
            // Read from the KIND, not re-derived from the reason string: an auth-403 is by
            // construction the scope family and nothing else (reasonFamily ranks the token and the
            // plan above the scope, and both of those map to 'forbidden'). Testing the string again
            // here would be a second classifier free to disagree with the one that chose the kind.
            // This branch is unreachable for a 'forbidden' error, so every tail below keeps exactly
            // the behaviour its own gates already pin.
            const scopeFamily = err.kind === 'auth';
            const tail = scopeFamily
              // mapStatus's scope sentence names this server's GENERIC read pair
              // (file_comments:read, file_content:read) because it is written for five call sites
              // at once. For this endpoint those are the wrong scopes, and a reader who checks them
              // finds them present and concludes the scope is not the problem. Correcting the
              // subject is this layer's job, exactly as search_design_system corrects "this file's
              // plan" to the team it actually called; the sentence above is not repeated.
              ? 'Figma named a scope. The scopes named above are this server\'s generic read pair,'
                + ' not the one this endpoint needs: the Variables REST API needs'
                + ' file_variables:read.'
                + ' Check that scope on the Personal access tokens page in Figma.'
              : tokenNamed && planNamed
              // Figma named two causes and the ranking answered one. Naming the other is not
              // second-guessing the ranking - the message still LEADS with the token - it is
              // refusing to drop a cause Figma put in the same sentence.
              ? 'Figma named a plan or account-type limit in the same reason, so a fresh token may'
                + ' not be enough on its own, and this endpoint also needs file_variables:read.'
                + ' Check that scope on the Personal access tokens page in Figma, then ask whoever'
                + ' owns this file which endpoints its plan covers.'
              : tokenNamed
                // Silent about plans on purpose: Figma named the token and nothing else, so raising
                // a plan here - even to deny it - re-supplies the premise this change removes.
                ? 'This endpoint also needs the file_variables:read scope on the token, and Figma'
                  + ' answers a missing scope with this same 403.'
                  + ' Check that scope on the Personal access tokens page in Figma.'
                : planNamed && scopeNamed
                // Adds the two endpoint-specific facts and picks NEITHER, because the half above
                // has just said Figma did not say which one refused the call.
                ? 'The scope this endpoint needs is file_variables:read, and a Figma plan can'
                  + ' exclude the Variables REST API outright.'
                  + ' Name both when you ask.'
                : planNamed
                  // Not "not available on this FILE's plan": one of the two strings this matches
                  // names the ACCOUNT type, which is not the same subject. Ends at an action
                  // mapStatus has NOT already given - its half already says "Ask whoever owns this
                  // file in Figma which endpoints its plan covers", and repeating that in different
                  // words reads as a stutter in the composite. What this layer knows and that one
                  // does not is WHICH endpoint.
                  ? 'Figma named a plan or account-type limit rather than a token problem, and the'
                    + ' Variables REST API is one of the endpoints a Figma plan can exclude.'
                    + ' Name that endpoint when you ask.'
                  // Completes mapStatus's list for THIS endpoint and stops. It does not repeat
                  // "open the file in Figma as that account" - the half above already says it, and
                  // the one thing missing from that half is the scope name.
                  : 'For this endpoint the possibilities are three things Figma answers identically:'
                    + " the file's Figma plan, the token being valid, and the token carrying"
                    + ' file_variables:read.'
                    + ' Check that scope on the Personal access tokens page in Figma.';
            // The one check that is always available, in the form THIS process can actually run.
            // Every tail above ends at something the reader does in Figma's web UI; none of them
            // ends at anything they can run against this instance, and on the branch where Figma
            // named nothing the alternative would be to invent a remedy for a cause nobody knows.
            // Derived from process.argv[1], because `framefit` is on PATH only inside the container
            // image or from a published package - a hard-coded string is wrong in the mode the
            // README leads with. It points at a check and names no culprit, so it composes with the
            // plan branch above, which has just said the token is not the problem.
            throw new Error(`${err.message} ${tail} ${tokenStatusHint(undefined, { perCallToken: args.figma_token !== undefined })}`);
          }
          if (err instanceof FigmaApiError && err.kind === 'unknown_4xx' && err.status === 400) {
            // Body-first: the too-large advice recommends splitting a design-system file, which is a
            // multi-day refactor. It must not be given for a 400 that merely reports a malformed
            // parameter. mapStatus's fallthrough assigns unknown_4xx to EVERY non-401/403/404/429
            // 4xx, so this branch sees both.
            const reason = err.upstreamReason ?? '';
            if (TOO_LARGE_REASON_RE.test(reason) || reason === '') {
              // err.message ends with mapStatus's generic 4xx tail ("Retrying this unchanged will
              // get the same answer"), which is FALSE for this endpoint's load-dependent job limit.
              // Forwarding it straight into "retry first" would hand the reader two contradictory
              // instructions, so the override is stated rather than implied - and with no reason at
              // all the paragraph is offered as the known candidate, not asserted as the cause.
              const lead = reason === ''
                ? 'Figma gave no reason for this 400, and that generic advice does not apply here: '
                : 'That generic advice does not apply here: ';
              throw new Error(
                `${err.message} ${lead}`
                + "Figma rejected this file's variables as too large (its server-side ~55s job limit - too many variables/modes). "
                + 'This is intermittent (load-dependent), so retry first - it often succeeds. '
                + 'If it keeps failing: the endpoint has no filtering and node-scoping still fetches the whole file, '
                + "so split the design-system file into smaller files. (Raising the request timeout does NOT help - this is Figma's job limit, not a client timeout.)",
              );
            }
            throw new Error(`${err.message} Check the call's parameters against the quoted reason before assuming a size problem.`);
          }
          if (err instanceof FigmaApiError && err.kind === 'network' && err.message.includes('timed out')) {
            throw new Error(
              // The em dash here was the last non-ASCII character in this tool's ERROR messages
              // (the description still carries several, recorded as backlog in
              // tool-annotations.test.ts). Checked on delivered text by a row in
              // tool-diagnosis-e2e.test.ts rather than by eye.
              `${err.message}. The variables endpoint is slow on large files - retry with a higher timeout_ms (up to 120000). ` +
              "If it still times out, the file's variables are likely too big to fetch whole; node-scoping won't help (it fetches the same file), so split the design-system file.",
            );
          }
          throw err;
        }
      }, deps.noTokenHint),
  );
}
