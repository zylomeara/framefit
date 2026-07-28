import type { Logger } from '../infrastructure/logger.js';
import type { FigmaApi } from '../ports/figma-api.js';
import { parseFileKey } from '../domain/parse-file-key.js';

export type PostedComment = {
  id: string;
  parent_id?: string;
  message: string;
};

function requireMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) throw new Error('message is required and must not be blank');
  return trimmed;
}

export async function postCommentUseCase(
  api: FigmaApi,
  logger: Logger,
  input: { file: string; message: string },
): Promise<PostedComment> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;
  const message = requireMessage(input.message);

  logger.info({ tool: 'post_comment', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.postComment(fileKey, { message });
  return { id: raw.id, parent_id: raw.parent_id, message: raw.message };
}

export async function replyCommentUseCase(
  api: FigmaApi,
  logger: Logger,
  input: { file: string; comment_id: string; message: string },
): Promise<PostedComment> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;
  const message = requireMessage(input.message);

  logger.info({ tool: 'reply_to_comment', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  const raw = await api.replyComment(fileKey, input.comment_id, { message });
  return { id: raw.id, parent_id: raw.parent_id, message: raw.message };
}

export async function deleteCommentUseCase(
  api: FigmaApi,
  logger: Logger,
  input: { file: string; comment_id: string },
): Promise<{ ok: true; comment_id: string }> {
  const parsed = parseFileKey(input.file);
  if (!parsed.ok) throw new Error(parsed.error);
  const fileKey = parsed.value;

  // Log field renamed with the tool: this is what an operator greps for use_case.start /
  // tool.error lines, and a log keyed to a tool name that no longer exists finds nothing.
  logger.info({ tool: 'delete_comment', file_key_prefix: fileKey.slice(0, 8) }, 'use_case.start');

  await api.deleteComment(fileKey, input.comment_id);
  return { ok: true, comment_id: input.comment_id };
}
