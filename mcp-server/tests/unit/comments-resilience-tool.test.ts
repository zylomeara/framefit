import { afterEach, describe, expect, it, vi } from 'vitest';
import { FigmaRestAdapter } from '../../src/adapters/driven/figma-rest.js';
import { registerGetCommentsTool, type ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { registerFindThreadsTool } from '../../src/adapters/driving/tools/find-threads-tool.js';
import { registerSummarizeCommentsTool } from '../../src/adapters/driving/tools/summarize-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const tools = ['get_comments', 'find_threads', 'summarize_comments'] as const;
const comment = (id: number) => ({
  id: String(id), parent_id: '', message: `Review spacing ${id}`,
  user: { id: 'reader', handle: 'Reader', img_url: '' },
  created_at: '2025-02-03T12:00:00Z', resolved_at: null,
  client_meta: { node_id: `7:${id}`, node_offset: { x: 0, y: 0 } },
});

function harness({ sourceFails = false, maxResultChars = 40000, count = 3, scopeFails = false } = {}) {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url);
    urls.push(u);
    if (u.pathname.endsWith('/comments') && !sourceFails) {
      return new Response(JSON.stringify({ comments: Array.from({ length: count }, (_, i) => comment(i + 1)) }));
    }
    if (scopeFails) return new Response(JSON.stringify(u.pathname.endsWith('/nodes')
      ? { nodes: {} }
      : { document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [] } }));
    return new Response(JSON.stringify({ status: 400, err: 'Request too large. If applicable, filter by query params.' }), { status: 400 });
  }));
  const fake = makeFakeMcpServer();
  const buildApi = vi.fn<ToolDeps['buildApi']>((token, timeout, deadline) =>
    new FigmaRestAdapter(token, logger, 4, timeout, undefined, undefined, deadline));
  const deps = { buildApi, defaultToken: 'test-token', logger, maxResultChars, toolTimeBudgetMs: 25000 };
  registerGetCommentsTool(fake.server, deps);
  registerFindThreadsTool(fake.server, deps);
  registerSummarizeCommentsTool(fake.server, deps);
  return {
    urls, buildApi,
    call: (name: typeof tools[number], args: Record<string, unknown> = {}) => fake.callParsed(name, {
      file: 'SampleFile', as_markdown: false, query: 'spacing', ...args,
    }),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('comment tools metadata failures', () => {
  it.each(tools)('%s retains fetched comments when node metadata returns 400', async (tool) => {
    const h = harness();
    const result = await h.call(tool);
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.coverage.filter).toMatchObject({ complete: true, unresolved_threads: 0, count_semantics: 'exact' });
    expect(out.coverage.enrichment).toMatchObject({ complete: false, error: { kind: 'unknown_4xx', status: 400 } });
    if (tool === 'get_comments') {
      expect(out.total_matching).toBe(3);
      expect(out.threads.map((t: any) => t.anchor.node_id)).toEqual(['7:1', '7:2', '7:3']);
    } else if (tool === 'find_threads') {
      expect(out.matches).toHaveLength(3);
    } else {
      expect(out.total).toBe(3);
    }
    expect(h.urls[0].pathname).toBe('/v1/files/SampleFile/comments');
    const metadata = h.urls.slice(1);
    expect(metadata.every((u) => u.pathname === '/v1/files/SampleFile/nodes' && u.searchParams.get('depth') === '1')).toBe(true);
    const batches = metadata.map((u) => u.searchParams.get('ids')!.split(','));
    expect(batches[0]).toEqual(['7:1', '7:2', '7:3']);
    expect(batches.at(-1)).toHaveLength(1);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].length).toBeLessThan(batches[i - 1].length);
      expect(batches[i].every((id) => batches[i - 1].includes(id))).toBe(true);
    }
  });

  it.each(tools)('%s keeps source-read failure distinct from an empty result', async (tool) => {
    const h = harness({ sourceFails: true });
    const result = await h.call(tool);
    expect(result.isError).toBe(true);
    const text = textOf(result.content[0]);
    expect(text).toContain('comments');
    expect(text).toContain('400');
    expect(text).toContain('client-side');
    expect(h.urls).toHaveLength(1);
  });

  it.each(tools)('%s reports unknown descendant membership instead of a clean zero', async (tool) => {
    const h = harness({ scopeFails: true });
    const result = await h.call(tool, { node_id: '7:90', include_descendants: true });
    expect(result.isError).not.toBe(true);
    const out = JSON.parse(textOf(result.content[0]));
    expect(out.coverage.filter).toMatchObject({ complete: false, unresolved_threads: 3, count_semantics: 'lower_bound' });
    if (tool === 'get_comments') expect(out.threads).toEqual([]);
    if (tool === 'find_threads') expect(out.matches).toEqual([]);
    if (tool === 'summarize_comments') expect(out.total).toBe(0);
  });

  it.each(tools)('%s wires the total deadline into the REST adapter', async (tool) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const h = harness();
    await h.call(tool, { timeout_ms: 120000 });
    expect(h.buildApi).toHaveBeenCalledWith('test-token', 120000, 1025000);
  });

  it('markdown exposes unknown membership before the thread body', async () => {
    const h = harness({ scopeFails: true });
    const result = await h.call('get_comments', { as_markdown: true, node_id: '7:90', include_descendants: true });
    const text = textOf(result.content[0]);
    expect(text).toContain('definite');
    expect(text).toContain('3 unresolved');
    expect(text).toContain('"complete":false');
    expect(text).not.toContain('0 of 0 matching');
  });

  it('clamped JSON retains the same coverage as the unclamped page', async () => {
    const large = harness({ count: 30 });
    const first = await large.call('get_comments');
    expect(first.isError).not.toBe(true);
    const original = JSON.parse(textOf(first.content[0]));
    const budget = textOf(first.content[0]).length - 1;
    const small = harness({ count: 30, maxResultChars: budget });
    const second = await small.call('get_comments');
    expect(second.isError).not.toBe(true);
    const out = JSON.parse(textOf(second.content[0]));
    expect(out.coverage).toEqual(original.coverage);
    expect(out.coverage).toBeDefined();
    expect(out.returned).toBeLessThan(original.returned);
    expect(textOf(second.content[0]).length).toBeLessThanOrEqual(budget);
  });
});
