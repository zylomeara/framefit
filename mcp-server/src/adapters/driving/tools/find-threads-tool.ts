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
    .describe('Typo-tolerant fuzzy matching. Default false uses fast exact substring. For word-form variants search by the common stem (e.g. "обнов"); enable fuzzy for typos.'),
  limit: z.number().int().min(1).max(50).default(10).describe('Max matches returned'),
  node_depth: z.number().int().min(0).max(10).default(0).describe('Figma /nodes depth for fallback name resolution'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-call Figma request timeout in ms (default 90000). Raise toward the 120000 max for very large files if you still hit timeouts.'),
};

export function registerFindThreadsTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'find_threads',
    'Search a Figma file\'s comment threads by text, ranked by relevance, with optional fuzzy matching and the full filter set. Returns scored matches with highlights — use to locate specific discussions in large files.',
    InputSchema,
    async (args) =>
      runTool('find_threads', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const out = await findThreadsUseCase(deps.buildApi(token, args.timeout_ms), deps.logger, {
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
