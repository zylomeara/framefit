import { describe, it, expect, vi } from 'vitest';
import {
  postCommentUseCase,
  replyCommentUseCase,
  deleteCommentUseCase,
} from '../../src/application/write-comments.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { RawComment } from '../../src/domain/types.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });

function makeComment(overrides: Partial<RawComment> = {}): RawComment {
  return {
    id: 'c-1',
    message: 'hello',
    user: { id: 'u1', handle: 'alice', img_url: '' },
    created_at: '2026-01-01T00:00:00Z',
    client_meta: { x: 0, y: 0 },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<FigmaApi> = {}): FigmaApi {
  return {
    getComments: vi.fn(),
    resolveNodes: vi.fn(),
    getFileStructure: vi.fn(),
    getDocumentRaw: vi.fn(),
    getNodesRaw: vi.fn(),
    getImages: vi.fn(),
    getVariablesLocal: vi.fn(),
    getFileVersion: vi.fn(),
    getTeamLibrary: vi.fn(),
    getTeamProjects: vi.fn(),
    getProjectFiles: vi.fn(),
    getFileComponents: vi.fn(),
    getComponent: vi.fn(),
    postComment: vi.fn(),
    replyComment: vi.fn(),
    deleteComment: vi.fn(),
    ...overrides,
  } as FigmaApi;
}

describe('postCommentUseCase', () => {
  it('parses Figma design URL and posts a root comment, returning id+message', async () => {
    const created = makeComment({ id: 'c-new', message: 'LGTM' });
    let seenKey = '';
    const api = fakeApi({
      postComment: vi.fn(async (fileKey: string) => {
        seenKey = fileKey;
        return created;
      }),
    });

    const result = await postCommentUseCase(api, logger, {
      file: 'https://www.figma.com/design/abc123/My?node-id=1-2',
      message: 'LGTM',
    });

    expect(seenKey).toBe('abc123');
    expect(result.id).toBe('c-new');
    expect(result.message).toBe('LGTM');
  });

  it('rejects empty/whitespace message', async () => {
    const api = fakeApi();
    await expect(
      postCommentUseCase(api, logger, { file: 'abc123', message: '   ' }),
    ).rejects.toThrow(/message/i);
  });
});

describe('replyCommentUseCase', () => {
  it('forwards comment_id when replying', async () => {
    const created = makeComment({ id: 'c-reply', parent_id: 'c-root', message: 'agreed' });
    let capturedCommentId = '';
    const api = fakeApi({
      replyComment: vi.fn(async (_fileKey: string, commentId: string) => {
        capturedCommentId = commentId;
        return created;
      }),
    });

    const result = await replyCommentUseCase(api, logger, {
      file: 'abc123',
      comment_id: 'c-root',
      message: 'agreed',
    });

    expect(capturedCommentId).toBe('c-root');
    expect(result.id).toBe('c-reply');
    expect(result.parent_id).toBe('c-root');
  });
});

describe('deleteCommentUseCase', () => {
  it('calls deleteComment and returns {ok:true, comment_id}', async () => {
    let called = false;
    const api = fakeApi({
      deleteComment: vi.fn(async () => { called = true; }),
    });

    const result = await deleteCommentUseCase(api, logger, {
      file: 'abc123',
      comment_id: 'c-42',
    });

    expect(called).toBe(true);
    expect(result).toEqual({ ok: true, comment_id: 'c-42' });
  });
});
