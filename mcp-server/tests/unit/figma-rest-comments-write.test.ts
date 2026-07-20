import { describe, it, expect, afterEach, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { createLogger } from '../../src/infrastructure/logger.js';

const logger = createLogger({ level: 'silent' });
afterEach(() => vi.unstubAllGlobals());

const api = () => new FigmaRestAdapter('figd_x', logger, 4, 30000);

describe('FigmaRestAdapter write methods', () => {
  it('postComment POSTs {message} and returns the created comment (id + X-Figma-Token + Content-Type)', async () => {
    const created = { id: 'c-new', parent_id: undefined, message: 'hello', user: { id: 'u1', handle: 'alice', img_url: '' }, created_at: '2026-01-01T00:00:00Z', client_meta: { x: 0, y: 0 } };
    let capturedInit: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return new Response(JSON.stringify(created), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await api().postComment('abc123', { message: 'hello' });

    expect(result.id).toBe('c-new');
    expect(result.message).toBe('hello');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as Record<string, string>)?.['X-Figma-Token']).toBe('figd_x');
    expect((capturedInit?.headers as Record<string, string>)?.['Content-Type']).toBe('application/json');
    const body = JSON.parse(capturedInit?.body as string);
    expect(body).toEqual({ message: 'hello' });
  });

  it('replyComment POSTs {message, comment_id} to the same endpoint', async () => {
    const created = { id: 'c-reply', parent_id: 'c-root', message: 'reply text', user: { id: 'u1', handle: 'alice', img_url: '' }, created_at: '2026-01-01T00:00:00Z', client_meta: { x: 0, y: 0 } };
    let capturedBody: unknown;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(created), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const result = await api().replyComment('abc123', 'c-root', { message: 'reply text' });

    expect(result.id).toBe('c-reply');
    expect(result.parent_id).toBe('c-root');
    expect(capturedBody).toEqual({ message: 'reply text', comment_id: 'c-root' });
  });

  it('resolveComment DELETEs and resolves undefined on 200 (empty body)', async () => {
    let capturedMethod: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method;
      return new Response('', { status: 200 });
    }));

    const result = await api().resolveComment('abc123', 'c-42');

    expect(result).toBeUndefined();
    expect(capturedMethod).toBe('DELETE');
  });

  it('postComment maps 403 to {kind: "forbidden"} with file_comments:write in message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response('Forbidden', { status: 403 });
    }));

    const err = await api().postComment('abc123', { message: 'x' }).catch(e => e);
    expect(err.kind).toBe('forbidden');
    expect(err.message).toContain('file_comments:write');
  });

  it('resolveComment maps 403 to {kind: "forbidden"} with file_comments:write in message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response('Forbidden', { status: 403 });
    }));

    const err = await api().resolveComment('abc123', 'c-42').catch(e => e);
    expect(err.kind).toBe('forbidden');
    expect(err.message).toContain('file_comments:write');
  });
});
