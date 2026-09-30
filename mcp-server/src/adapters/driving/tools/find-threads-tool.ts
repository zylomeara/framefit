import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { findThreadsUseCase } from '../../../application/find-threads.js';
import { FilterSchema, toCriteria } from './shared-schemas.js';
import { runTool, jsonResult } from './shared-error-handler.js';

const InputSchema = {
  ...FilterSchema,
  query: z.string().min(2).describe('Search text; space-separated words are AND clauses'),
  fuzzy: z
    .boolean()
    .default(false)
    .describe('Typo-tolerant fuzzy matching. Default false uses fast exact substring. For word-form variants search by the common stem (e.g. "updat" matches update/updated/updating); enable fuzzy for typos.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max matches returned'),
  node_depth: z.number().int().min(0).max(10).default(0).describe('Legacy option, accepted but ignored. Anchor metadata uses depth 1; descendant filtering has its own bounded traversal.'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-request Figma timeout in ms (default 90000), additionally bounded by the server whole-tool deadline. Raising this does not extend that deadline.'),
};

export function registerFindThreadsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'find_threads',
    {
      description: 'Search a Figma file\'s comment threads by text, ranked by relevance, with optional fuzzy matching and the shared client-side filters. Returns scored matches with highlights. coverage.filter.complete=false means unclassified candidates remain; an empty result does not prove absence and the ranking covers definite matches only. Anchor labels are best-effort, reported separately in coverage.enrichment.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('find_threads', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90000);
        const out = await findThreadsUseCase(deps.buildApi(token, args.timeout_ms, deadlineAt), deps.logger, {
          deadlineAt,
          file: args.file,
          criteria: toCriteria(args),
          query: args.query,
          fuzzy: args.fuzzy,
          limit: args.limit,
          node_depth: args.node_depth,
        });
        return jsonResult(out);
      }, deps.noTokenHint),
  );
}
