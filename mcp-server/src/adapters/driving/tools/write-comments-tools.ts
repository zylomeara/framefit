import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDeps } from './get-comments-tool.js';
import { runTool, jsonResult, assertWritable } from './shared-error-handler.js';
import {
  postCommentUseCase,
  replyCommentUseCase,
  resolveCommentUseCase,
} from '../../../application/write-comments.js';

// Writes always use the connection's default token (no per-call override) so a write can't be issued under an ad-hoc token.
export function registerWriteCommentsTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    'post_comment',
    {
      description: 'Post a new root-level comment on a Figma file. Disabled in read-only mode.',
      inputSchema: {
        file: z.string().min(1).describe('Figma file URL or raw file key'),
        message: z.string().min(1).describe('Comment text'),
      },
    },
    async (args) =>
      runTool('post_comment', deps.logger, deps.defaultToken, async (token) => {
        const refusal = await assertWritable(deps.readOnly);
        if (refusal) return refusal;
        const out = await postCommentUseCase(deps.buildApi(token), deps.logger, {
          file: args.file,
          message: args.message,
        });
        return jsonResult(out);
      }, deps.noTokenHint),
  );

  server.registerTool(
    'reply_to_comment',
    {
      description: 'Reply to an existing comment thread in a Figma file. Disabled in read-only mode.',
      inputSchema: {
        file: z.string().min(1).describe('Figma file URL or raw file key'),
        comment_id: z.string().min(1).describe('ID of the root comment to reply to'),
        message: z.string().min(1).describe('Reply text'),
      },
    },
    async (args) =>
      runTool('reply_to_comment', deps.logger, deps.defaultToken, async (token) => {
        const refusal = await assertWritable(deps.readOnly);
        if (refusal) return refusal;
        const out = await replyCommentUseCase(deps.buildApi(token), deps.logger, {
          file: args.file,
          comment_id: args.comment_id,
          message: args.message,
        });
        return jsonResult(out);
      }, deps.noTokenHint),
  );

  server.registerTool(
    'resolve_comment',
    {
      description: 'Resolve a Figma comment thread (marks it resolved; it stays visible in the file). Disabled in read-only mode. Pass the comment id from get_comments.',
      inputSchema: {
        file: z.string().min(1).describe('Figma file URL or raw file key'),
        comment_id: z.string().min(1).describe('ID of the comment or thread root to resolve'),
      },
    },
    async (args) =>
      runTool('resolve_comment', deps.logger, deps.defaultToken, async (token) => {
        const refusal = await assertWritable(deps.readOnly);
        if (refusal) return refusal;
        const out = await resolveCommentUseCase(deps.buildApi(token), deps.logger, {
          file: args.file,
          comment_id: args.comment_id,
        });
        return jsonResult(out);
      }, deps.noTokenHint),
  );
}
