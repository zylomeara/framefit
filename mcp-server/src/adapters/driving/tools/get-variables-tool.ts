import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult } from './shared-error-handler.js';
import { serializeForDelivery } from './serialize.js';
import { clampToBudget } from '../../../application/get-comments.js';
import { parseFileKey } from '../../../domain/parse-file-key.js';
import { normalizeNodeId, NODE_ID_RE } from '../../../domain/node-id.js';
import { listTokens, listTokensForIds, collectNodeVariableIds } from '../../../domain/variables.js';
import { extractLibraryKey } from '../../../domain/variable-snapshot.js';
import { FigmaApiError } from '../../../ports/errors.js';
import { summarizeTokens, filterTokens, dedupeTokens, canonicalizeCollections } from '../../../domain/variables-summary.js';

const InputSchema = {
  file: z.string().min(1).describe('Figma file URL or raw key'),
  node_id: z.string().regex(NODE_ID_RE, 'expected "1:42" or "1-42"').optional().describe('When set, return ONLY the variables referenced by this node subtree (the headless analogue of get_variable_defs). Omit for the whole-file token catalog.'),
  depth: z.number().int().min(1).max(8).default(4).describe('Subtree depth scanned for variable references (node_id mode only).'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-call Figma request timeout in ms (default 90000). The variables endpoint can be slow on large files — raise toward the 120000 max if you still hit timeouts.'),
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
      description: 'List design tokens (Figma variables) in a file: name, type, default-mode value (colors as hex), and collection. Pass node_id to return ONLY the variables a node subtree references (the headless analogue of get_variable_defs) instead of the whole-file catalog. Returns a summary header (total, resolved_via buckets {local,graph,snapshot}, unresolved count, by_type counts) plus optional filters (collection, name, type, unresolved_only) and pagination (limit/offset). Duplicate rows are deduped and case-variant collection names are unified. Aliases within the file are resolved. Cross-library aliases are resolved headless via the registered library graph: when the source library\'s team is registered, the token returns value:<hex>, resolved_via:"graph", and source_library (the source file key). Otherwise it stays honest — value:null, alias:true, alias_of:<VariableID> — meaning that library\'s team is not registered yet (register it to resolve). Requires the file to expose variables (Enterprise plan); raise timeout_ms on large files. Multi-mode tokens (collections with >1 mode) carry mode_dependent:true and modes:{<modeName>:<hex>} — value is the DEFAULT mode; do not treat it as the on-screen value without checking the node\'s mode (see get_design_context).',
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
            const nid = normalizeNodeId(args.node_id);
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

          // Delivered byte-clamp: get_variables was the only read tool without one; a multi-mode
          // page can exceed the result budget even after count pagination. Measured on the SAME
          // serialization jsonResult delivers (serializeForDelivery — compact by default), so the
          // guard bounds the real wire payload. Honest: summary/total_matching stay over the full
          // catalog; next_offset advances to the clamp cut so a re-request continues the tail.
          const budget = deps.maxResultChars ?? 40000;
          const { kept: tokens, clamped } = clampToBudget(pageTokens, budget, (xs) =>
            serializeForDelivery({ summary, total_matching: filtered.length, returned: xs.length, next_offset: null, tokens: xs }));
          const next_offset = offset + tokens.length < filtered.length ? offset + tokens.length : null;

          return jsonResult({
            summary,
            total_matching: filtered.length,
            returned: tokens.length,
            next_offset,
            ...(clamped ? { clamped: true } : {}),
            tokens,
          });
        } catch (err) {
          if (err instanceof FigmaApiError && err.kind === 'forbidden') {
            throw new Error('Figma denied variables access. The Variables REST API requires an Enterprise plan (and a token with file_variables:read).');
          }
          if (err instanceof FigmaApiError && err.kind === 'unknown_4xx' && err.status === 400) {
            throw new Error(
              "Figma rejected this file's variables as too large (its server-side ~55s job limit — too many variables/modes). " +
              "This is intermittent (load-dependent), so retry first — it often succeeds. " +
              "If it keeps failing: the endpoint has no filtering and node-scoping still fetches the whole file, " +
              "so split the design-system file into smaller files. (Raising the request timeout does NOT help — this is Figma's job limit, not a client timeout.)",
            );
          }
          if (err instanceof FigmaApiError && err.kind === 'network' && err.message.includes('timed out')) {
            throw new Error(
              `${err.message}. The variables endpoint is slow on large files — retry with a higher timeout_ms (up to 120000). ` +
              "If it still times out, the file's variables are likely too big to fetch whole; node-scoping won't help (it fetches the same file), so split the design-system file.",
            );
          }
          throw err;
        }
      }, deps.noTokenHint),
  );
}
