import { describe, it, expect, vi } from 'vitest';
import { registerGetVariablesTool } from '../../src/adapters/driving/tools/get-variables-tool.js';
import { createLogger } from '../../src/infrastructure/logger.js';
import { FigmaApiError } from '../../src/ports/errors.js';
import type { FigmaApi } from '../../src/ports/figma-api.js';
import type { ToolDeps } from '../../src/adapters/driving/tools/get-comments-tool.js';
import { CachingFigmaApiAdapter, type ReadCaches } from '../../src/adapters/driven/caching-figma-api.js';
import { FileStructureCache } from '../../src/infrastructure/file-structure-cache.js';
import { TtlCache } from '../../src/infrastructure/node-cache.js';
import { makeFakeMcpServer, textOf } from '../helpers/fake-mcp-server.js';

const logger = createLogger({ level: 'silent' });

function harness(getVariablesLocal: FigmaApi['getVariablesLocal'], maxResultChars?: number) {
  const { server, call } = makeFakeMcpServer();
  const deps: ToolDeps = {
    buildApi: () => ({
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getNodesRaw: async () => ({ nodes: {} }),
      getImages: async () => ({ images: {} }), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getVariablesLocal,
    } as unknown as FigmaApi),
    defaultToken: 'figd_x', logger, maxResultChars,
  };
  registerGetVariablesTool(server, deps);
  return (a: any): Promise<any> => call('get_variables', a);
}

describe('get_variables tool', () => {
  it('returns a flat token list', async () => {
    const run = harness(async () => ({ meta: {
      variableCollections: { 'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
      variables: { 'V:1': { id: 'V:1', name: 'space/md', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 16 } } },
    } }));
    const res = await run({ file: 'abc' });
    expect(res.content[0].text).toContain('"space/md"');
    expect(res.content[0].text).toContain('16');
  });

  it('maps a forbidden (non-Enterprise) error to a clear hint', async () => {
    const run = harness(async () => { throw new FigmaApiError('forbidden', 403, 'no'); });
    const res = await run({ file: 'abc' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Enterprise/i);
  });

  // R8-F3: OBSOLETE BY DESIGN as originally written — that version fed a hand-built
  // FigmaApiError('forbidden', 403, 'cached: ...') straight into the harness to assert the
  // Enterprise hint survives negative-cache reconstruction. But 'forbidden' is a per-TOKEN
  // verdict and is now NEVER negative-cached (a weak token's 403 must not poison a different,
  // possibly stronger token's call) — that reconstructed shape can no longer occur in practice.
  // Rewritten to pin the real (more honest) behavior through the REAL CachingFigmaApiAdapter:
  // every repeated 403 reaches the real API again (never served from a marker), and the
  // Enterprise hint still fires on each real call.
  it('a forbidden (403) is never negative-cached: the second call reaches the real API and still gets the Enterprise hint', async () => {
    let calls = 0;
    const inner: FigmaApi = {
      getComments: async () => [], resolveNodes: async () => new Map(), getFileStructure: async () => ({}) as any,
      getDocumentRaw: async () => ({}) as any, getNodesRaw: async () => ({ nodes: {} }),
      getImages: async () => ({ images: {} }), getFileVersion: async () => ({ version: '1', name: 'F', lastModified: 'X' }),
      getVariablesLocal: async () => { calls++; throw new FigmaApiError('forbidden', 403, 'Figma denied variables access'); },
    } as unknown as FigmaApi;
    const readCaches: ReadCaches = {
      nodeCache: new TtlCache(300_000), variablesCache: new TtlCache(300_000),
      variablesErrorCache: new TtlCache<string>(600_000), versionCache: new TtlCache(60_000),
      librariesCache: new TtlCache(300_000), componentCache: new TtlCache(300_000),
      docCache: new TtlCache(300_000), componentSetsCache: new TtlCache(300_000), imageFillsCache: new TtlCache(300_000),
    };
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: (_token: string, timeoutMs?: number) =>
        new CachingFigmaApiAdapter(inner, new FileStructureCache(300_000), logger, readCaches, { timeoutMs: timeoutMs ?? 90_000 }),
      defaultToken: 'figd_x', logger,
    };
    registerGetVariablesTool(server, deps);

    const res1 = await call('get_variables', { file: 'abc' });
    expect(res1.isError).toBe(true);
    expect(res1.content[0].text).toMatch(/Enterprise/i);

    const res2 = await call('get_variables', { file: 'abc' });
    expect(res2.isError).toBe(true);
    expect(res2.content[0].text).toMatch(/Enterprise/i);

    expect(calls).toBe(2); // never cached — both calls reached the real (fake) API
  });

  it('passes timeout_ms through to buildApi', async () => {
    let seenTimeout: number | undefined;
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: (_t: string, timeoutMs?: number) => {
        seenTimeout = timeoutMs;
        return { getVariablesLocal: async () => ({ meta: { variableCollections: {}, variables: {} } }) } as unknown as FigmaApi;
      },
      defaultToken: 'figd_x', logger,
    };
    registerGetVariablesTool(server, deps);
    await call('get_variables', { file: 'abc', timeout_ms: 90000 });
    expect(seenTimeout).toBe(90000);
  });

  it('does not fail the tool when the snapshot lookup throws (degrades to honest aliases)', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC': { id: 'VC', name: 'Theme', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V': { id: 'V', name: 'bg/accent', resolvedType: 'COLOR', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:abcdef0123456789abcdef0123456789abcdef01/1:1' } } } },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableSnapshot: { lookup: async () => { throw new Error('snapshot db down'); } },
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(textOf(res.content[0]));
    const t = body.tokens.find((x: any) => x.name === 'bg/accent');
    expect(t.value).toBeNull();
    expect(t.alias).toBe(true);
  });

  it('resolves cross-library aliases via the variableSnapshot lookup (by extracted published key)', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC': { id: 'VC', name: 'Theme', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V': { id: 'V', name: 'bg/accent', resolvedType: 'COLOR', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:abcdef0123456789abcdef0123456789abcdef01/9:9' } } } },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableSnapshot: { lookup: async (keys) => new Map(keys.includes('abcdef0123456789abcdef0123456789abcdef01') ? [['abcdef0123456789abcdef0123456789abcdef01', { value: '#abcdef', resolved_type: 'COLOR', name: 'primitive/blue' }]] : []) },
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc' });
    const body = JSON.parse(textOf(res.content[0]));
    const t = body.tokens.find((x: any) => x.name === 'bg/accent');
    expect(t.value).toBe('#abcdef');
    expect(t.resolved_via).toBe('snapshot');
  });

  it('resolves cross-library aliases via the library graph (resolved_via:graph + source_library)', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC': { id: 'VC', name: 'Theme', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V': { id: 'V', name: 'bg/accent', resolvedType: 'COLOR', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:abcdef0123456789abcdef0123456789abcdef01/9:9' } } } },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableGraph: { resolve: (k) => k === 'abcdef0123456789abcdef0123456789abcdef01' ? { value: '#abcdef', sourceLibrary: 'LIBKEY' } : undefined },
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc' });
    const body = JSON.parse(textOf(res.content[0]));
    const t = body.tokens.find((x: any) => x.name === 'bg/accent');
    expect(t.value).toBe('#abcdef');
    expect(t.resolved_via).toBe('graph');
    expect(t.source_library).toBe('LIBKEY');
  });

  it('returns summary header, filters by collection, and marks unresolved aliases with a hint', async () => {
    const run = harness(async () => ({
      meta: {
        variableCollections: {
          'VC:1': { id: 'VC:1', name: 'Colors', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] },
          'VC:2': { id: 'VC:2', name: 'Spacing', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] },
        },
        variables: {
          'V:1': { id: 'V:1', name: 'colors/red',   resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } },
          'V:2': { id: 'V:2', name: 'colors/blue',  resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 0, g: 0, b: 1, a: 1 } } },
          'V:3': { id: 'V:3', name: 'spacing/sm',   resolvedType: 'FLOAT', variableCollectionId: 'VC:2', valuesByMode: { m: 8 } },
        },
      },
    }));
    const res = await run({ file: 'abc', collection: 'colors' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.summary.total).toBe(3);
    expect(body.returned).toBe(2);
    expect(body.tokens.every((t: any) => t.collection === 'Colors')).toBe(true);
  });

  it('returns summary with unresolved count and hint on unresolved tokens', async () => {
    const run = harness(async () => ({
      meta: {
        variableCollections: {
          'VC:1': { id: 'VC:1', name: 'Colors', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] },
        },
        variables: {
          'V:1': { id: 'V:1', name: 'colors/red',   resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { r: 1, g: 0, b: 0, a: 1 } } },
          'V:2': { id: 'V:2', name: 'ext/bg',       resolvedType: 'COLOR', variableCollectionId: 'VC:1', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: 'VariableID:abcdef0123456789abcdef0123456789abcdef01/1:1' } } },
        },
      },
    }));
    const res = await run({ file: 'abc' });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.summary.unresolved).toBe(1);
    const unresolvedToken = body.tokens.find((t: any) => t.name === 'ext/bg');
    expect(unresolvedToken.hint).toMatch(/register/i);
  });

  it('supports pagination: limit + offset, returns next_offset', async () => {
    const run = harness(async () => ({
      meta: {
        variableCollections: {
          'VC:1': { id: 'VC:1', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] },
        },
        variables: {
          'V:1': { id: 'V:1', name: 'a', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 1 } },
          'V:2': { id: 'V:2', name: 'b', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 2 } },
          'V:3': { id: 'V:3', name: 'c', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 3 } },
          'V:4': { id: 'V:4', name: 'd', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 4 } },
          'V:5': { id: 'V:5', name: 'e', resolvedType: 'FLOAT', variableCollectionId: 'VC:1', valuesByMode: { m: 5 } },
        },
      },
    }));
    const res = await run({ file: 'abc', limit: 2, offset: 1 });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.summary.total).toBe(5);
    expect(body.returned).toBe(2);
    expect(body.next_offset).toBe(3);
  });

  it('graph-first + per-key snapshot fallback: graph resolves aaaa key, snapshot resolves bbbb key; lookup called with only missed keys', async () => {
    const AAAA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 40 hex chars
    const BBBB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; // 40 hex chars
    const { server, call } = makeFakeMcpServer();
    const lookupFn = vi.fn(async (keys: string[]) => new Map(
      keys.includes(BBBB) ? [[BBBB, { value: '#bbbbbb', resolved_type: 'COLOR', name: 'lib/blue' }]] : []
    ));
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC': { id: 'VC', name: 'Theme', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: {
          'VA': { id: 'VA', name: 'color/a', resolvedType: 'COLOR', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${AAAA}/1:1` } } },
          'VB': { id: 'VB', name: 'color/b', resolvedType: 'COLOR', variableCollectionId: 'VC', valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${BBBB}/2:2` } } },
        },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableGraph: { resolve: (k) => k === AAAA ? { value: '#aaaaaa', sourceLibrary: 'LIBAAAA' } : undefined },
      variableSnapshot: { lookup: lookupFn },
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc' });
    const body = JSON.parse(textOf(res.content[0]));
    const ta = body.tokens.find((x: any) => x.name === 'color/a');
    const tb = body.tokens.find((x: any) => x.name === 'color/b');
    // graph-resolved token
    expect(ta.value).toBe('#aaaaaa');
    expect(ta.resolved_via).toBe('graph');
    // snapshot-resolved token (fallback for missed key)
    expect(tb.value).toBe('#bbbbbb');
    expect(tb.resolved_via).toBe('snapshot');
    // lookup was called exactly once, with only the missed key (BBBB), not AAAA
    expect(lookupFn).toHaveBeenCalledTimes(1);
    const calledWith = lookupFn.mock.calls[0][0] as string[];
    expect(calledWith).not.toContain(AAAA);
    expect(calledWith).toContain(BBBB);
  });

  it('node_id mode returns only the variables the node subtree references', async () => {
    const { server, call } = makeFakeMcpServer();
    const deps: ToolDeps = {
      buildApi: () => ({
        getVariablesLocal: async () => ({ meta: {
          variableCollections: { VC: { id: 'VC', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
          variables: {
            'V:1': { id: 'V:1', name: 'used/space', resolvedType: 'FLOAT', variableCollectionId: 'VC', valuesByMode: { m: 8 } },
            'V:2': { id: 'V:2', name: 'unused/space', resolvedType: 'FLOAT', variableCollectionId: 'VC', valuesByMode: { m: 4 } },
          },
        } }),
        getNodesRaw: async () => ({ nodes: { '1:5': { document: { id: '1:5', name: 'F', type: 'FRAME', boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'V:1' } } } } } }),
      } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc', node_id: '1-5' });
    const body = JSON.parse(textOf(res.content[0]));
    expect(body.tokens.map((x: any) => x.name)).toEqual(['used/space']);
    expect(body.summary.total).toBe(1);
  });

  it('node_id mode errors when the node is not in the file', async () => {
    const run = harness(async () => ({ meta: {
      variableCollections: { VC: { id: 'VC', name: 'Brand', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
      variables: { 'V:1': { id: 'V:1', name: 'a', resolvedType: 'FLOAT', variableCollectionId: 'VC', valuesByMode: { m: 1 } } },
    } }));
    const res = await run({ file: 'abc', node_id: '9-9' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
  });

  it('emits modes + mode_dependent for a cross-library multi-mode token (via graph)', async () => {
    const { server, call } = makeFakeMcpServer();
    const KEY = 'abcdef0123456789abcdef0123456789abcdef01';
    const deps: ToolDeps = {
      buildApi: () => ({ getVariablesLocal: async () => ({ meta: {
        variableCollections: { 'VC': { id: 'VC', name: 'Local', defaultModeId: 'm', modes: [{ modeId: 'm', name: 'L' }] } },
        variables: { 'V': { id: 'V', name: 'text icon/accent', resolvedType: 'COLOR', variableCollectionId: 'VC',
          valuesByMode: { m: { type: 'VARIABLE_ALIAS', id: `VariableID:${KEY}/9:9` } } } },
      } }) } as unknown as FigmaApi),
      defaultToken: 'figd_x', logger,
      variableGraph: { resolve: (k) => k === KEY
        ? { value: '#a73afd', name: 'text icon/accent', modesByName: { Default: '#a73afd', MonogramDark: '#8b6afb' } }
        : undefined },
    };
    registerGetVariablesTool(server, deps);
    const res = await call('get_variables', { file: 'abc' });
    const body = JSON.parse(textOf(res.content[0]));
    const t = body.tokens.find((x: any) => x.name === 'text icon/accent');
    expect(t.mode_dependent).toBe(true);
    expect(t.modes).toEqual({ Default: '#a73afd', MonogramDark: '#8b6afb' });
  });

  it('byte-clamps the tokens page and reports clamped + advancing next_offset', async () => {
    // 40 tokens with long names/values → page ≈ 9KB through serializeForDelivery, exceeds a 2000 budget.
    const vars: Record<string, unknown> = {};
    const cols = { 'c1': { id: 'c1', name: 'Col', modes: [{ modeId: 'm1', name: 'Default' }], defaultModeId: 'm1' } };
    for (let i = 0; i < 40; i++) {
      vars[`v${i}`] = { id: `v${i}`, name: `token-name-${'x'.repeat(60)}-${i}`, resolvedType: 'STRING',
        variableCollectionId: 'c1', valuesByMode: { m1: `value-${'y'.repeat(60)}-${i}` } };
    }
    const tool = harness((async () => ({ meta: { variableCollections: cols, variables: vars } })) as unknown as FigmaApi['getVariablesLocal'], 2000);
    const res = await tool({ file: 'k', limit: 1000 } as never);
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out.clamped).toBe(true);
    expect(out.returned).toBeLessThan(out.total_matching); // measured: returned=8, total_matching=40
    expect(out.next_offset).toBe(out.returned);            // advanced to the clamp cut (offset 0 + returned)
    expect(out.tokens).toHaveLength(out.returned);
  });

  it('does NOT add a clamped field when the page fits (default output unchanged)', async () => {
    const cols = { 'c1': { id: 'c1', name: 'Col', modes: [{ modeId: 'm1', name: 'Default' }], defaultModeId: 'm1' } };
    const vars = { 'v1': { id: 'v1', name: 't', resolvedType: 'STRING', variableCollectionId: 'c1', valuesByMode: { m1: 'hi' } } };
    const tool = harness((async () => ({ meta: { variableCollections: cols, variables: vars } })) as unknown as FigmaApi['getVariablesLocal']);
    const res = await tool({ file: 'k' } as never);
    const out = JSON.parse((res.content[0] as { text: string }).text);
    expect(out).not.toHaveProperty('clamped');
    expect(out.returned).toBe(1);
  });

  it('maps Figma 400 (too large) to a retry/split error — NOT timeout_ms (wrong remedy for a server-side job limit)', async () => {
    const tool = harness(async () => { throw new FigmaApiError('unknown_4xx', 400, 'Request too large'); });
    const res = await tool({ file: 'ABC123' } as never);
    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toMatch(/too large/i);
    expect(text).toMatch(/retry/i);          // intermittent → retry first
    expect(text).toMatch(/split/i);          // structural fix if it persists
    expect(text).not.toMatch(/timeout_ms/i); // 400 is Figma's job limit; timeout_ms does NOT help
    expect(text).not.toMatch(/node_id/i);    // node-scoping still fetches /local → same 400
    expect(text).not.toMatch(/unknown_4xx|Figma returned 400/); // no generic kind leak
  });

  it('maps a request-timeout to an actionable error that DOES steer to timeout_ms', async () => {
    const tool = harness(async () => { throw new FigmaApiError('network', 0, 'Figma request timed out after 90000ms'); });
    const res = await tool({ file: 'ABC123' } as never);
    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toMatch(/timed out/i);
    expect(text).toMatch(/timeout_ms/i);   // OUR client cap → raising it genuinely helps
    expect(text).toMatch(/120000/);        // the documented ceiling
    expect(text).not.toMatch(/node_id/i);  // node-scoping still fetches /local → same slowness
    expect(text).not.toMatch(/\[network\]/); // remapped to a plain Error → no kind leak
  });

  it('leaves a non-timeout network error (unreachable) as a generic rethrow', async () => {
    const tool = harness(async () => { throw new FigmaApiError('network', 0, 'Could not reach Figma API: ECONNREFUSED'); });
    const res = await tool({ file: 'ABC123' } as never);
    expect(res.isError).toBe(true);
    const text = res.content[0].text as string;
    expect(text).toMatch(/\[network\]/);      // unchanged: still the generic FigmaApiError surface
    expect(text).not.toMatch(/timeout_ms/i);  // no timeout remedy for an unreachable host
  });
});
