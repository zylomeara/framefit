import { afterEach, describe, expect, it, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { registerGetCommentsTool } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { registerFindThreadsTool } from '../../src/adapters/driving/tools/find-threads-tool.js';
import { registerSummarizeCommentsTool } from '../../src/adapters/driving/tools/summarize-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const tools = ['get_comments', 'find_threads', 'summarize_comments'] as const;
const logger = createLogger({ level: 'silent' });

function harness(omitMissingKey = false, projectionError?: 'too_large' | 'unknown_4xx' | 'bad_request' | 'rate_limited') {
  const urls: URL[] = [];
  const frame = (id: number) => ({ id: `72:${id}`, name: `Panel ${id}`, type: 'FRAME', children: [] });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url);
    urls.push(u);
    if (u.pathname.endsWith('/comments')) {
      return new Response(JSON.stringify({ comments: [1, 2, 3, 4].map((id) => ({
        id: String(id), parent_id: '', message: `Check spacing ${id}`,
        user: { id: 'reviewer', handle: 'Reviewer', img_url: '' },
        created_at: '2025-03-08T12:00:00Z', resolved_at: null,
        client_meta: { node_id: `72:${id}`, node_offset: { x: 0, y: 0 } },
      })) }));
    }
    if (!u.pathname.endsWith('/nodes') && u.searchParams.has('ids')) {
      if (projectionError && u.searchParams.get('ids')!.split(',').length > 2) {
        if (projectionError === 'too_large') {
          return new Response('{}', { headers: { 'content-length': '999999' } });
        }
        const status = projectionError === 'rate_limited' ? 429 : 400;
        const err = projectionError === 'unknown_4xx' ? 'Request too large. If applicable, filter by query params.' : 'Invalid parameter';
        return new Response(JSON.stringify({ status, err }), { status, headers: { 'retry-after': '13' } });
      }
      return new Response(JSON.stringify({
        name: 'Sample', lastModified: '2025-03-08T12:00:00Z', version: 'revision-a',
        document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [
          { id: '72:90', name: 'First page', type: 'CANVAS', children: [frame(1), frame(2)] },
          { id: '72:91', name: 'Second page', type: 'CANVAS', children: [frame(3)] },
        ] },
      }));
    }
    const ids = (u.searchParams.get('ids') ?? '').split(',');
    if (u.pathname.endsWith('/nodes') && !ids.includes('72:90')) {
      const nodes = Object.fromEntries(ids
        .filter((id) => !(omitMissingKey && id === '72:4'))
        .map((id) => [id, id === '72:4' ? null : { document: frame(Number(id.split(':')[1])) }]));
      return new Response(JSON.stringify({ version: 'revision-a', nodes }));
    }
    return new Response(JSON.stringify({ status: 400, err: 'Request too large. If applicable, filter by query params.' }), { status: 400 });
  }));
  const fake = makeFakeMcpServer();
  const deps = {
    buildApi: (token: string, timeout?: number, deadline?: number) =>
      new FigmaRestAdapter(token, logger, 4, timeout, undefined, undefined, deadline, 4096),
    defaultToken: 'test-token', logger, maxResultChars: 40000,
  };
  registerGetCommentsTool(fake.server, deps);
  registerFindThreadsTool(fake.server, deps);
  registerSummarizeCommentsTool(fake.server, deps);
  return {
    urls,
    call: (tool: typeof tools[number], args: Record<string, unknown> = {}) => fake.callParsed(tool, {
      file: 'ScopeFile', as_markdown: false, query: 'spacing',
      node_id: '72:90', include_descendants: true, ...args,
    }),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('scoped comments through REST and tool delivery', () => {
  it.each(tools)('%s delivers exact counts without reading the scope subtree', async (tool) => {
    const h = harness();
    const result = await h.call(tool);
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.coverage.filter).toMatchObject({
      complete: true, candidate_threads: 4, evaluated_threads: 4,
      unresolved_threads: 0, count_semantics: 'exact',
    });
    if (tool === 'get_comments') {
      expect(out.total_matching).toBe(2);
      expect(out.threads.map((t: { id: string }) => t.id)).toEqual(['1', '2']);
    } else if (tool === 'find_threads') {
      expect(out.matches.map((t: { thread_id: string }) => t.thread_id).sort()).toEqual(['1', '2']);
    } else {
      expect(out.total).toBe(2);
    }
    const metadata = h.urls.filter((u) => !u.pathname.endsWith('/comments'));
    expect(metadata.every((u) => !u.searchParams.get('ids')?.split(',').includes('72:90'))).toBe(true);
    expect(metadata[0].searchParams.get('depth')).toBe('3');
    expect(metadata.slice(1).every((u) => u.searchParams.get('version') === 'revision-a')).toBe(true);
    expect(metadata.some((u) => u.pathname.endsWith('/nodes') && u.searchParams.get('ids') === '72:4')).toBe(true);
  });

  it.each(tools)('%s preserves unresolved membership when a node key is omitted', async (tool) => {
    const h = harness(true);
    const result = await h.call(tool);
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.coverage.filter).toMatchObject({
      complete: false, evaluated_threads: 3, unresolved_threads: 1, count_semantics: 'lower_bound',
    });
    if (tool === 'get_comments') expect(out.total_matching).toBe(2);
    if (tool === 'find_threads') expect(out.matches).toHaveLength(2);
    if (tool === 'summarize_comments') expect(out.total).toBe(2);
  });

  it.each(['too_large', 'unknown_4xx'] as const)('recovers from an adapter-produced %s size error', async (kind) => {
    const h = harness(false, kind);
    const result = await h.call('get_comments');
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.threads.map((t: { id: string }) => t.id)).toEqual(['1', '2']);
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0 });
    expect(h.urls.filter((u) => u.pathname.endsWith('/ScopeFile'))).toHaveLength(3);
  });

  it.each(['bad_request', 'rate_limited'] as const)('does not retry an adapter-produced %s error', async (kind) => {
    const h = harness(false, kind);
    const result = await h.call('get_comments');
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.coverage.filter).toMatchObject({
      complete: false, unresolved_threads: 4,
      error: { kind: kind === 'bad_request' ? 'unknown_4xx' : 'rate_limited', status: kind === 'bad_request' ? 400 : 429 },
    });
    if (kind === 'rate_limited') expect(out.coverage.filter.error.retry_after_sec).toBe(13);
    expect(h.urls.filter((u) => u.pathname.endsWith('/ScopeFile'))).toHaveLength(1);
  });

  it('paginates only after complete scope classification', async () => {
    const h = harness();
    const result = await h.call('get_comments', { limit: 1, offset: 1 });
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.total_matching).toBe(2);
    expect(out.threads.map((t: { id: string }) => t.id)).toEqual(['2']);
    expect(out.coverage.filter).toMatchObject({ complete: true, candidate_threads: 4 });
    expect(out.next_offset).toBeNull();
  });

  it('keeps summary totals independent of displayed top lists', async () => {
    const h = harness();
    const result = await h.call('summarize_comments', { top_n: 1 });
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.total).toBe(2);
    expect(out.by_top_nodes).toHaveLength(1);
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0 });
  });
});
