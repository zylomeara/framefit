// Batch 2 item 6 (B), panel-rebuilt: the live incident (a socket close at scale 2, a manual
// retry at scale 1 succeeded) does NOT isolate the scale - n=1 cannot separate "too big"
// from "the second attempt was later" (the repo's only other network retry is a SAME-request
// re-dial, getFileStructure). The ship is a two-step ladder on the MAIN render only:
// step 1 = one retry at the SAME parameters (all formats, all modes; invisible on success);
// step 2 = one render at max(1, scale/2), ONLY after step 1 failed in the same trigger
// class AND format is raster AND scale > 1 AND the mode consumes the main render as the
// delivered image (focus/preview/tiles are excluded - their compositing math reads the
// requested scale in too many places; the exclusion is the named residual).
// Trigger class: kind 'network', NOT a timeout (the 90s AbortError also maps to 'network'
// and doubling it would be a ~270s call), NOT a queued bailout (evidence about our queue,
// never about the endpoint). Degradation is ALWAYS visible: scale/width/height report the
// DELIVERED scale, requested_scale + scale_note ride along, inline gains a second (text)
// content item only when degraded. A double/triple failure rethrows the ORIGINAL error
// with one appended sentence naming what was attempted - the agent must not re-dial a
// proven-dead road blind.
import { describe, it, expect, vi } from 'vitest';
import { registerGetScreenshotTool } from '../../src/adapters/driving/tools/get-screenshot-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { makeFakeMcpServer } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

const netErr = () => new FigmaApiError('network', 0, 'Could not reach Figma API: The socket connection was closed unexpectedly');
const timeoutErr = () => new FigmaApiError('network', 0, 'Figma request timed out after 90000ms');
const bailoutErr = () => new FigmaApiError('network', 0, 'Could not reach Figma API: deadline exhausted while queued', undefined, undefined, true);

function harness(getImages: FigmaApi['getImages']) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getNodesRaw: async (_f: string, ids: string[]) => ({
        nodes: Object.fromEntries(ids.map((i) => [i, { document: { id: i, name: 'n', absoluteBoundingBox: { x: 0, y: 0, width: 360, height: 891 } } }])),
      }),
      getImages,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger,
  };
  registerGetScreenshotTool(server, deps);
  return (a: Record<string, unknown>) => call('get_screenshot', a);
}

// getImages fake that fails N times with the given errors, then succeeds; records scales.
function failing(errors: unknown[], urls: Record<string, string> = { '1:1': 'https://img.example/ok' }) {
  const scales: (number | undefined)[] = [];
  const fn = vi.fn(async (_f: string, _ids: string[], opts?: { scale?: number }) => {
    scales.push(opts?.scale);
    if (fn.mock.calls.length <= errors.length) throw errors[fn.mock.calls.length - 1];
    return { images: urls };
  });
  return { fn: fn as unknown as FigmaApi['getImages'], scales, spy: fn };
}

describe('step 1: one same-parameters retry on a transient transport drop', () => {
  it('network then success -> url mode is byte-identical to an undegraded response; two calls, same scale', async () => {
    const clean = failing([]);
    const flaky = failing([netErr()]);
    const runClean = harness(clean.fn);
    const runFlaky = harness(flaky.fn);
    const a = { file: 'abc', node_id: '1:1', scale: 2 };
    const cleanOut = (await runClean(a)).content[0].text as string;
    const flakyOut = (await runFlaky(a)).content[0].text as string;
    expect(flakyOut).toBe(cleanOut);                       // invisible by construction
    expect(flaky.spy).toHaveBeenCalledTimes(2);
    expect(flaky.scales).toEqual([2, 2]);
  });

  it('a timeout-shaped network error NEVER retries (one call)', async () => {
    const f = failing([timeoutErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(res.isError).toBe(true);
    expect(f.spy).toHaveBeenCalledTimes(1);
  });

  it('a queued bailout NEVER retries (one call)', async () => {
    const f = failing([bailoutErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(res.isError).toBe(true);
    expect(f.spy).toHaveBeenCalledTimes(1);
  });

  it('non-network kinds NEVER retry (one call, error surfaces unchanged)', async () => {
    const f = failing([new FigmaApiError('upstream', 200, 'Figma returned an error for this render')]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/upstream|error for this render/i);
    expect(f.spy).toHaveBeenCalledTimes(1);
  });
});

describe('step 2: the scale fallback after a double transient failure', () => {
  it('network x2 then scale-1 success -> delivered scale 1, requested_scale 2, scale_note, dimensions at 1', async () => {
    const f = failing([netErr(), netErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    const out = JSON.parse(res.content[0].text as string);
    expect(f.scales).toEqual([2, 2, 1]);
    expect(out.scale).toBe(1);
    expect(out.requested_scale).toBe(2);
    expect(out.scale_note).toMatch(/failed twice/);
    expect(out.scale_note).not.toMatch(/too (big|large)/i);  // factual wording - no size-cause claim
    expect(out.width).toBe(360);                             // 360 x scale 1, not x2
    expect(out.height).toBe(891);
  });

  it('scale 4 halves to 2, not to 1 (a scale-4 caller is chasing detail)', async () => {
    const f = failing([netErr(), netErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 4 });
    const out = JSON.parse(res.content[0].text as string);
    expect(f.scales).toEqual([4, 4, 2]);
    expect(out.scale).toBe(2);
    expect(out.requested_scale).toBe(4);
  });

  it('svg never reaches step 2: two calls, the error carries the step-1 sentence only', async () => {
    const f = failing([netErr(), netErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', format: 'svg', scale: 2 });
    expect(res.isError).toBe(true);
    expect(f.spy).toHaveBeenCalledTimes(2);
    expect(res.content[0].text).toMatch(/An immediate retry failed the same way/);
    expect(res.content[0].text).not.toMatch(/scale-\d+ fallback/);
  });

  it('scale 1 never reaches step 2 (nothing to drop to)', async () => {
    const f = failing([netErr(), netErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 1 });
    expect(res.isError).toBe(true);
    expect(f.spy).toHaveBeenCalledTimes(2);
  });

  it('preview, tiles AND focus modes never reach step 2 (mode exclusion - the main render is not the delivered image there)', async () => {
    for (const extra of [{ return: 'preview' }, { tiles: true }, { focus: { x: 0.5, y: 0.5 } }]) {
      const f = failing([netErr(), netErr()]);
      const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2, ...extra });
      expect(res.isError).toBe(true);
      expect(f.spy).toHaveBeenCalledTimes(2);
      expect(res.content[0].text).toMatch(/An immediate retry failed the same way/);
    }
  });

  it('a retry failing in a DIFFERENT class surfaces THAT error, never a false "failed the same way"', async () => {
    // 429: the backoff signal must survive.
    const f429 = failing([netErr(), new FigmaApiError('rate_limited', 429, 'Figma rate limit hit; retry after 30s', 30)]);
    const r429 = await harness(f429.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(r429.isError).toBe(true);
    expect(r429.content[0].text).toMatch(/rate limit/i);
    expect(r429.content[0].text).not.toMatch(/failed the same way/);
    expect(r429.content[0].text).toMatch(/first attempt failed on a transport drop/);
    // upstream 200-body: the render reason must survive.
    const fUp = failing([netErr(), new FigmaApiError('upstream', 200, 'Figma returned an error for this render')]);
    const rUp = await harness(fUp.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(rUp.content[0].text).toMatch(/error for this render/);
    // a timeout on the retry is a different class too (the ~90s hang is not "the same way").
    const fT = failing([netErr(), timeoutErr()]);
    const rT = await harness(fT.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(rT.content[0].text).toMatch(/timed out/);
    expect(rT.content[0].text).not.toMatch(/failed the same way/);
    // step 3 in a different class: e3 surfaces with its own advice.
    const f3 = failing([netErr(), netErr(), new FigmaApiError('unknown_4xx', 400, 'Figma rejected the render')]);
    const r3 = await harness(f3.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(r3.content[0].text).toMatch(/rejected the render/);
    expect(r3.content[0].text).toMatch(/two prior attempts failed on transport drops/);
  });

  it('inline degraded -> image + a SECOND text content item with the meta; undegraded inline stays single-item', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 })));
    try {
      const clean = failing([]);
      const cleanRes = await harness(clean.fn)({ file: 'abc', node_id: '1:1', scale: 2, return: 'inline' });
      expect(cleanRes.content).toHaveLength(1);            // the historical single-item shape
      const f = failing([netErr(), netErr()]);
      const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2, return: 'inline' });
      expect(res.content).toHaveLength(2);
      expect(res.content[0].type).toBe('image');
      const meta = JSON.parse(res.content[1].text as string);
      expect(meta).toMatchObject({ scale: 1, requested_scale: 2 });
      expect(meta.scale_note).toMatch(/failed twice/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('triple failure -> the ORIGINAL error text plus the sentence naming the scale fallback; three calls', async () => {
    const f = failing([netErr(), netErr(), netErr()]);
    const res = await harness(f.fn)({ file: 'abc', node_id: '1:1', scale: 2 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/socket connection was closed/);
    expect(res.content[0].text).toMatch(/scale-1 fallback both failed/);
    expect(f.spy).toHaveBeenCalledTimes(3);
  });
});
