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
// Delivered lengths (unclamped full page, compact): markdown=685, JSON envelope=1613.
// Conservative measure (as-if-clamped: next_offset=total + more_available + auto_clamped
// warnings) per prefix n threads — this is what the tool's clamp closure actually measures:
//   consMD:   n1=534 n2=669 n3=829 n4=976
//   consJSON: n1=916 n2=1203 n3=1602 n4=1923
// The conservative warnings cushion (~290 md / ~310 JSON) EXCEEDS the sibling tools' +100 slack,
// so a "deliveredLen+100 → no clamp" co-lock is NOT achievable here: the clamp decision is
// self-referential (delivering a clamp ADDS the long auto_clamped warning), and the tool resolves
// that fixpoint by always measuring as-if-clamped. Tight-probe budgets are therefore anchored
// ABOVE the conservative full-page measure, not at deliveredLen+100.

function fakeApi(): Partial<FigmaApi> {
  return {
    getComments: vi.fn(async () => rawComments),
    getFileStructure: vi.fn(async () => structure),
    resolveNodes: vi.fn(async () => new Map()),
  };
}

function harness(maxResultChars: number) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = { buildApi: () => fakeApi() as FigmaApi, defaultToken: 'figd_x', logger, maxResultChars };
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

  // Moved from the use-case test (:129): auto_clamped is now the tool's job. Budget 1200 (JSON)
  // sits between consJSON(1)=916 and consJSON(2)=1203, so the conservative measure keeps 1 thread.
  it('auto-clamps + emits auto_clamped when the delivered envelope exceeds budget', async () => {
    const run = harness(1200);
    const res = await run({ ...base, as_markdown: false, limit: 50 });
    const out = JSON.parse(res.content[0].text);
    expect(out.returned).toBeLessThan(out.total_matching);
    expect(out.warnings.map((w: { code: string }) => w.code)).toContain('auto_clamped');
    expect(out.next_offset).toBe(out.returned); // offset 0 + kept
    expect(res.content[0].text.length).toBeLessThanOrEqual(1200); // never exceeds budget
  });

  // md-clamp lock (markdown budget previously had 0 coverage). The markdown branch measures the
  // EXACT delivered plain-text (header + '\n\n' + formatMarkdown), NOT the JSON form.
  it('budget (markdown): measured == delivered plain-text, not the JSON form, not body-without-header', async () => {
    const big = await harness(400000)({ ...base, as_markdown: true });
    const bigText = big.content[0].text as string;
    const deliveredLen = bigText.length; // 685
    expect(threadCount(bigText)).toBe(4);
    expect(bigText).not.toContain('⚠ [auto_clamped]');

    // Tight budget 1200: correct md measure consMD(4)=976 fits → no clamp. A "measure JSON-form"
    // mutation would measure consJSON (1923 for 4) and over-clamp to 1 thread (consJSON(2)=1203 >
    // 1200) → returned<4 → this assertion goes RED (false-alarm lock).
    const tight = await harness(1200)({ ...base, as_markdown: true });
    const tightText = tight.content[0].text as string;
    expect(threadCount(tightText)).toBe(4);              // no false clamp
    expect(tightText).not.toContain('⚠ [auto_clamped]');
    expect(tightText.length).toBeLessThanOrEqual(1200);  // delivered ≤ budget

    // Edge budget deliveredLen-1 (684): correct code must clamp; delivered ≤ 684. A "formatMarkdown
    // without header" mutation measures body-only (658 for 4 threads ≤ 684) → thinks all 4 fit → delivers
    // header+body = 685 > 684 → this assertion goes RED (overflow lock). deliveredLen+slack can't
    // catch that under-count; only a budget BELOW the true delivered length forces a real decision.
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
    const deliveredLen = big.content[0].text.length; // 1613
    const bigOut = JSON.parse(big.content[0].text);
    expect(bigOut.returned).toBe(bigOut.total_matching);
    expect(bigOut.warnings).toEqual([]);

    // Tight budget 2100 (> consJSON(4)=1923): correct code does not clamp.
    const tight = await harness(2100)({ ...base, as_markdown: false });
    const tightOut = JSON.parse(tight.content[0].text);
    expect(tightOut.returned).toBe(tightOut.total_matching); // no false clamp
    expect(tight.content[0].text.length).toBeLessThanOrEqual(2100);

    // Edge budget deliveredLen-1 (1612): correct code clamps to 3 (consJSON(3)=1602 ≤ 1612). A
    // the "bare array" mutation measures the bare threads array (1497 for 4 ≤ 1612) → thinks all 4
    // fit → delivers the full 1613-char envelope > 1612 → this assertion goes RED (overflow lock).
    const edge = await harness(deliveredLen - 1)({ ...base, as_markdown: false });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
    const edgeOut = JSON.parse(edge.content[0].text);
    expect(edgeOut.returned).toBeLessThan(edgeOut.total_matching); // genuinely clamped
  });

  // MCP_PRETTY_JSON lock: delivery is pretty AND the measure is pretty (lockstep — both go through
  // serializeForDelivery, which reads the env). A mutation that hardcodes a compact measure while
  // delivering pretty would under-count and overflow the budget.
  it('budget (json, MCP_PRETTY_JSON=true): delivered pretty, measured pretty — delivered ≤ budget', async () => {
    process.env.MCP_PRETTY_JSON = 'true';
    const big = await harness(400000)({ ...base, as_markdown: false });
    const bigText = big.content[0].text as string;
    const deliveredLen = bigText.length; // 2719 — pretty (indented) is much larger than compact 1613
    expect(deliveredLen).toBeGreaterThan(1613);
    expect(bigText).toContain('\n  '); // sanity: 2-space indentation present

    // Edge budget deliveredLen-1 (2718 ≥ compact consJSON 1923): the pretty measure forces a clamp
    // so delivered ≤ budget. A compact-measure mutation (consJSON 1923 ≤ 2718) would think all 4 fit
    // → deliver pretty 2719 > 2718 → this assertion goes RED.
    const edge = await harness(deliveredLen - 1)({ ...base, as_markdown: false });
    expect(edge.content[0].text.length).toBeLessThanOrEqual(deliveredLen - 1);
    const edgeOut = JSON.parse(edge.content[0].text);
    expect(edgeOut.returned).toBeLessThan(edgeOut.total_matching);
  });
});
