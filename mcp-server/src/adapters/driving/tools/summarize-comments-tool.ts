import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { summarizeCommentsUseCase } from '../../../application/summarize-comments.js';
import { FilterSchema, toCriteria } from './shared-schemas.js';
import { runTool, jsonResult } from './shared-error-handler.js';

const InputSchema = {
  ...FilterSchema,
  node_depth: z.number().int().min(0).max(10).default(0).describe('Legacy option, accepted but ignored. Descendant filtering uses bounded ancestor lookups with internally selected depths.'),
  top_n: z.number().int().min(1).max(50).default(10).describe('How many entries in by_top_nodes and top_threads_by_replies'),
  timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Per-request Figma timeout in ms (default 90000), additionally bounded by the server whole-tool deadline. Raising this does not extend that deadline.'),
};

export function registerSummarizeCommentsTool(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'summarize_comments',
    {
      description: 'Aggregate statistics for a Figma file\'s comments (counts by author/anchor/node/date, top threads, mentions) using the same client-side filters as get_comments. top_n limits displayed lists, not the counted population. coverage.filter.complete=false means counts are lower bounds over definite matches, not a complete census. Names/pages are best-effort and their availability is reported separately in coverage.enrichment.',
      inputSchema: InputSchema,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      runTool('summarize_comments', deps.logger, args.figma_token ?? deps.defaultToken, async (token) => {
        const deadlineAt = Date.now() + (deps.toolTimeBudgetMs ?? 90000);
        const summary = await summarizeCommentsUseCase(deps.buildApi(token, args.timeout_ms, deadlineAt), deps.logger, {
          deadlineAt,
          file: args.file,
          criteria: toCriteria(args),
          node_depth: args.node_depth,
          top_n: args.top_n,
        });
        return jsonResult(summary);
      }, deps.noTokenHint),
  );
}
