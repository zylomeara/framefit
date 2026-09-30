import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerGetCommentsTool } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import type { RawComment } from '../../src/domain/types.js';
import type { RawDocumentNode } from '../../src/domain/file-structure.js';
import { buildFileStructure } from '../../src/domain/file-structure.js';
import fixture from '../fixtures/comments-sample.json';
import structFixture from '../fixtures/file-structure-sample.json';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });
const rawComments = fixture.comments as unknown as RawComment[];
const structure = buildFileStructure(structFixture.document as unknown as RawDocumentNode);

// Fixture groups into 4 threads (1001 has reply 1002; 2001/3001/4001 are roots).
// Edge probes use the delivered envelope, including coverage and pagination warnings.

function fakeApi(comments = rawComments): Partial<FigmaApi> {
  return {
    getComments: vi.fn(async () => comments),
    getNodesRaw: vi.fn(async (_file: string, ids: string[]) => ({
      nodes: Object.fromEntries(ids.map((id) => [id, structure.nodeById.has(id)
        ? { document: structure.nodeById.get(id)! } : null])),
    })),
  };
}

function harness(maxResultChars: number, comments = rawComments) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => fakeApi(comments) as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars };
  registerGetCommentsTool(server, deps);
  return (a: any): Promise<any> => call('get_comments', a);
}

const base = { file: 'ABCXYZ', include_resolved: true, include_descendants: false, node_depth: 0, limit: 50, offset: 0 };
const threadCount = (md: string) => (md.match(/## Thread #/g) ?? []).length;

describe('get_comments tool', () => {
  afterEach(() => { delete process.env.MCP_PRETTY_JSON; });

  it('markdown: delivers header + rendered threads', async () => {
    const run = harness(40000);
    const res = await run({ ...base, as_markdown: true });
    const text = res.content[0].text as string;
    expect(text).toContain('(4 of 4 matching threads)');
    expect(text).toContain('## Thread #1001');
    expect(text).toContain('Button / Primary'); // resolved node name from structure
    expect(threadCount(text)).toBe(4);
  });

  it('json: delivers the full envelope shape', async () => {
    const run = harness(40000);
    const res = await run({ ...base, as_markdown: false });
    const out = JSON.parse(res.content[0].text);
    expect(out.total_matching).toBe(4);
    expect(out.returned).toBe(4);
    expect(out.next_offset).toBeNull();
    expect(out.threads.length).toBe(4);
    expect(out.warnings).toEqual([]);
  });

  // Moved from the use-case test (:123): more_available is now the tool's job — it fires when the
  // page does not reach the end of the matching set (offset+kept < total_matching).
  it('emits more_available + next_offset when paginating (limit < total)', async () => {
    const runMd = harness(40000);
    const md = await runMd({ ...base, as_markdown: true, limit: 2 });
    const text = md.content[0].text as string;
    expect(text).toContain('next_offset=2');
    expect(text).toContain('⚠ [more_available]');
    expect(threadCount(text)).toBe(2);

    const runJson = harness(40000);
    const json = await runJson({ ...base, as_markdown: false, limit: 2 });
    const out = JSON.parse(json.content[0].text);
    expect(out.returned).toBe(2);
    expect(out.next_offset).toBe(2);
    expect(out.warnings.map((w: { code: string }) => w.code)).toContain('more_available');
  });

  it('auto-clamps + emits auto_clamped when the delivered envelope exceeds budget', async () => {
    const budget = 1800;
    const run = harness(budget);
    const res = await run({ ...base, as_markdown: false, limit: 50 });
    expect(res.isError).not.toBe(true);
    const out = JSON.parse(res.content[0].text);
    expect(out.returned).toBeGreaterThan(0);
    expect(out.returned).toBeLessThan(out.total_matching);
    expect(out.warnings.map((w: { code: string }) => w.code)).toContain('auto_clamped');
    expect(out.next_offset).toBe(out.returned);
    expect(res.content[0].text.length).toBeLessThanOrEqual(budget);
  });

  // md-clamp lock (markdown budget previously had 0 coverage). The markdown branch measures the
  // EXACT delivered plain-text (header + '\n\n' + formatMarkdown), NOT the JSON form.
  it('budget (markdown): measured == delivered plain-text, not the JSON form, not body-without-header', async () => {
    const big = await harness(400000)({ ...base, as_markdown: true });
    const bigText = big.content[0].text as string;
    const deliveredLen = bigText.length;
    expect(threadCount(bigText)).toBe(4);
    expect(bigText).not.toContain('⚠ [auto_clamped]');

    // This budget fits markdown but not the equivalent JSON envelope.
    const tight = await harness(1200)({ ...base, as_markdown: true });
    const tightText = tight.content[0].text as string;
    expect(threadCount(tightText)).toBe(4);              // no false clamp
    expect(tightText).not.toContain('⚠ [auto_clamped]');
    expect(tightText.length).toBeLessThanOrEqual(1200);  // delivered ≤ budget

    // A budget below the full delivered text catches a measure that omits its header.
    const edge = await harness(deliveredLen - 1)({ ...base, as_markdown: true });
    const edgeText = edge.content[0].text as string;
    expect(edgeText.length).toBeLessThanOrEqual(deliveredLen - 1);
    expect(threadCount(edgeText)).toBeLessThan(4);        // genuinely clamped
    expect(edgeText).toContain('⚠ [auto_clamped]');
  });

  // JSON-clamp lock: measures the delivered envelope through serializeForDelivery (same fn
  // jsonResult delivers) — not a bare threads array.
  it('budget (json): measured == delivered envelope (serializeForDelivery), not the bare array', async () => {
    const big = await harness(400000)({ ...base, as_markdown: false });
    const deliveredLen = big.content[0].text.length;
    const bigOut = JSON.parse(big.content[0].text);
    expect(bigOut.returned).toBe(bigOut.total_matching);
    expect(bigOut.warnings).toEqual([]);

    // A fitting page must not lose threads to a conservative measure.
    const tight = await harness(2100)({ ...base, as_markdown: false });
    const tightOut = JSON.parse(tight.content[0].text);
    expect(tightOut.returned).toBe(tightOut.total_matching); // no false clamp
    expect(tight.content[0].text.length).toBeLessThanOrEqual(2100);

    // A budget below the delivered envelope catches measuring the bare threads array.
    const edge = await harness(deliveredLen - 1)({ ...base, as_markdown: false });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
    const edgeOut = JSON.parse(edge.content[0].text);
    expect(edgeOut.returned).toBeLessThan(edgeOut.total_matching); // genuinely clamped
  });

  it('keeps the established near-limit warning on a fitting JSON page', async () => {
    const res = await harness(2300)({ ...base, as_markdown: false });
    const out = JSON.parse(res.content[0].text);

    expect(out.returned).toBe(out.total_matching);
    expect(out.warnings.map((w: { code: string }) => w.code)).toContain('large_result');
    expect(res.content[0].text.length).toBeLessThanOrEqual(2300);
  });

  // MCP_PRETTY_JSON lock: delivery is pretty AND the measure is pretty (lockstep — both go through
  // serializeForDelivery, which reads the env). A mutation that hardcodes a compact measure while
  // delivering pretty would under-count and overflow the budget.
  it('budget (json, MCP_PRETTY_JSON=true): delivered pretty, measured pretty — delivered ≤ budget', async () => {
    process.env.MCP_PRETTY_JSON = 'true';
    const big = await harness(400000)({ ...base, as_markdown: false });
    const bigText = big.content[0].text as string;
    const deliveredLen = bigText.length;
    expect(deliveredLen).toBeGreaterThan(JSON.stringify(JSON.parse(bigText)).length);
    expect(bigText).toContain('\n  '); // sanity: 2-space indentation present

    // Compact-only measurement cannot safely bound this pretty-printed delivery.
    const edge = await harness(deliveredLen - 1)({ ...base, as_markdown: false });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
    const edgeOut = JSON.parse(edge.content[0].text);
    expect(edgeOut.returned).toBeLessThan(edgeOut.total_matching);
  });

  it('returns a fixed overflow error when the first JSON thread cannot fit the supported minimum budget', async () => {
    const sentinel = `REQUEST_SENTINEL_${'x'.repeat(1400)}`;
    const res = await harness(1000, [{ ...rawComments[0], message: sentinel }])({ ...base, as_markdown: false, limit: 1 });
    const text = res.content[0].text as string;

    expect(text.length).toBeLessThanOrEqual(1000);
    expect(res.isError).toBe(true);
    expect(JSON.parse(text)).toEqual({ code: 'response_too_large', reason: 'first_item_oversize', action: 'narrow_request' });
    expect(JSON.parse(text)).not.toHaveProperty('next_offset');
    expect(text).not.toContain(sentinel);
  });
});
