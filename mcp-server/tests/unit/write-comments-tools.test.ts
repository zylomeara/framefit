import { describe, it, expect, vi } from 'vitest';
import { registerWriteCommentsTools } from '../../src/adapters/driving/tools/write-comments-tools.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { RawComment } from '../../src/domain/types.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { SINGLE_TENANT_READ_ONLY_REMEDIATION } from '../../src/adapters/driving/tools/shared-error-handler.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

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

function makeDeps(overrides: Partial<ToolDeps> & { apiOverride?: Partial<FigmaApi> } = {}): ToolDeps {
  const { apiOverride, ...rest } = overrides;
  const api: FigmaApi = {
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
    postComment: vi.fn(async () => makeComment({ id: 'c-posted', message: 'ok' })),
    replyComment: vi.fn(async () => makeComment({ id: 'c-reply', parent_id: 'c-root', message: 'reply' })),
    deleteComment: vi.fn(async () => undefined),
    ...apiOverride,
  } as FigmaApi;
  return {
    buildApi: () => api,
    defaultToken: 'figd_test',
    logger,
    ...rest,
  };
}

describe('write-comments tools', () => {
  it('post_comment posts a comment when writable and returns id', async () => {
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, makeDeps());

    const res = await call('post_comment', { file: 'abc123', message: 'LGTM' });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res.content[0]));
    expect(parsed.id).toBe('c-posted');
  });

  it('post_comment is REFUSED (read-only) with no REST call when read_only=true', async () => {
    let called = false;
    const deps = makeDeps({
      readOnly: { isReadOnly: async () => true, remediation: SINGLE_TENANT_READ_ONLY_REMEDIATION },
      apiOverride: {
        postComment: vi.fn(async () => { called = true; return makeComment(); }),
      },
    });
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, deps);

    const res = await call('post_comment', { file: 'abc123', message: 'x' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/i);
    expect(called).toBe(false);
  });

  it('reply_to_comment forwards comment_id', async () => {
    let capturedCommentId = '';
    const deps = makeDeps({
      apiOverride: {
        replyComment: vi.fn(async (_fileKey: string, commentId: string) => {
          capturedCommentId = commentId;
          return makeComment({ id: 'c-reply', parent_id: commentId, message: 'ack' });
        }),
      },
    });
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, deps);

    const res = await call('reply_to_comment', { file: 'abc123', comment_id: 'c-root', message: 'ack' });

    expect(res.isError).toBeFalsy();
    expect(capturedCommentId).toBe('c-root');
    const parsed = JSON.parse(textOf(res.content[0]));
    expect(parsed.parent_id).toBe('c-root');
  });

  it('delete_comment is refused when read_only=true', async () => {
    const deps = makeDeps({
      readOnly: { isReadOnly: async () => true, remediation: SINGLE_TENANT_READ_ONLY_REMEDIATION },
    });
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, deps);

    const res = await call('delete_comment', { file: 'abc123', comment_id: 'c-42' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/read-only/i);
  });

  it('writes proceed when readOnly gate is undefined (single-tenant/stdio)', async () => {
    const deps = makeDeps({ readOnly: undefined });
    const { server, call } = makeFakeMcpServer();
    registerWriteCommentsTools(server, deps);

    const res = await call('delete_comment', { file: 'abc123', comment_id: 'c-99' });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res.content[0]));
    expect(parsed.ok).toBe(true);
  });
});
