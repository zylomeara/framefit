import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { summarizeCommentsUseCase } from '../../../application/summarize-comments.js';
import { FilterSchema, toCriteria } from './shared-schemas.js';
import { runTool, jsonResult } from './shared-error-handler.js';

const InputSchema = {
  ...FilterSchema,
  node_depth: z.number().int().min(0).max(10).default(0).describe('Figma /nodes depth for fallback name resolution'),
  top_n: z.number().int().min(1).max(50).default(10).describe('How many entries in by_top_nodes and top_threads_by_replies'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-call Figma request timeout in ms (default 90000). Raise toward the 120000 max for very large files if you still hit timeouts.'),
};

export function registerSummarizeCommentsTool(server: McpServer, deps: ToolDeps): void {
  server.tool(
    'summarize_comments',
    'Aggregate statistics for a Figma file\'s comments (counts by author/anchor/node/date, top threads, mentions) using the same filters as get_comments. Returns a compact ~1-2KB summary — use this first to scope large files before fetching full threads.',
    InputSchema,
    async (args) =>
      runTool('summarize_comments', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const summary = await summarizeCommentsUseCase(deps.buildApi(token, args.timeout_ms), deps.logger, {
          file: args.file,
          criteria: toCriteria(args),
          node_depth: args.node_depth,
          top_n: args.top_n,
        });
        return jsonResult(summary);
      }, deps.noTokenHint),
  );
}
